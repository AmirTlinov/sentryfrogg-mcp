#!/usr/bin/env node
"use strict";
// @ts-nocheck
Object.defineProperty(exports, "__esModule", { value: true });
// SentryFrogg MCP Server v7.0.1
process.on('unhandledRejection', (reason, promise) => {
    process.stderr.write(`🔥 Unhandled Promise Rejection: ${reason}\n`);
    process.stderr.write(`Promise: ${promise}\n`);
});
process.on('uncaughtException', (error) => {
    process.stderr.write(`🔥 Uncaught Exception: ${error.message}\n`);
    process.exit(1);
});
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError, } = require('@modelcontextprotocol/sdk/types.js');
const crypto = require('crypto');
const fsSync = require('fs');
const fs = require('fs/promises');
const path = require('path');
const Ajv = require('ajv');
const ServiceBootstrap = require('./src/bootstrap/ServiceBootstrap');
const { isUnsafeLocalEnabled } = require('./src/utils/featureFlags');
const { redactObject, redactText } = require('./src/utils/redact');
const { suggest } = require('./src/utils/suggest');
const { normalizeArgsAliases } = require('./src/utils/argAliases');
const { buildToolCallContextRef, buildToolCallFileRef, writeTextArtifact } = require('./src/utils/artifacts');
const ToolError = require('./src/errors/ToolError');
const HELP_TOOL_ALIASES = {
    sql: 'mcp_psql_manager',
    psql: 'mcp_psql_manager',
    ssh: 'mcp_ssh_manager',
    job: 'mcp_jobs',
    artifacts: 'mcp_artifacts',
    http: 'mcp_api_client',
    api: 'mcp_api_client',
    repo: 'mcp_repo',
    state: 'mcp_state',
    project: 'mcp_project',
    context: 'mcp_context',
    workspace: 'mcp_workspace',
    env: 'mcp_env',
    vault: 'mcp_vault',
    runbook: 'mcp_runbook',
    capability: 'mcp_capability',
    intent: 'mcp_intent',
    evidence: 'mcp_evidence',
    alias: 'mcp_alias',
    preset: 'mcp_preset',
    audit: 'mcp_audit',
    pipeline: 'mcp_pipeline',
    local: 'mcp_local',
};
const CORE_TOOL_NAMES = new Set([
    'help',
    'legend',
    'mcp_workspace',
    'mcp_jobs',
    'mcp_artifacts',
    'mcp_project',
]);
const RESPONSE_MODES = new Set(['compact', 'ai']);
function normalizeResponseMode(value) {
    if (value === undefined || value === null) {
        return null;
    }
    const normalized = String(value).trim().toLowerCase();
    if (!normalized) {
        return null;
    }
    if (RESPONSE_MODES.has(normalized)) {
        return normalized;
    }
    throw new McpError(ErrorCode.InvalidParams, `response_mode: expected one of ${Array.from(RESPONSE_MODES).join(', ')}`);
}
function resolveResponseMode(args) {
    const payload = args && typeof args === 'object' && !Array.isArray(args) ? args : null;
    const explicit = payload && Object.prototype.hasOwnProperty.call(payload, 'response_mode')
        ? normalizeResponseMode(payload.response_mode)
        : null;
    if (explicit) {
        return explicit;
    }
    return 'ai';
}
function stripResponseMode(args) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
        return args;
    }
    if (!Object.prototype.hasOwnProperty.call(args, 'response_mode')) {
        return args;
    }
    const { response_mode, ...rest } = args;
    return rest;
}
function isMachineResponseMode(mode) {
    return mode === 'ai' || mode === 'compact';
}
function presentToolName({ tool, invokedAs }) {
    if (invokedAs) {
        return invokedAs;
    }
    // DX-friendly aliases for a few high-leverage tools.
    switch (tool) {
        case 'mcp_ssh_manager':
            return 'ssh';
        case 'mcp_artifacts':
            return 'artifacts';
        case 'mcp_jobs':
            return 'job';
        default:
            return tool;
    }
}
function truncateUtf8Prefix(value, maxBytes) {
    if (typeof value !== 'string') {
        return '';
    }
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
        return '';
    }
    if (Buffer.byteLength(value, 'utf8') <= maxBytes) {
        return value;
    }
    let low = 0;
    let high = value.length;
    while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        const slice = value.slice(0, mid);
        const bytes = Buffer.byteLength(slice, 'utf8');
        if (bytes <= maxBytes) {
            low = mid;
        }
        else {
            high = mid - 1;
        }
    }
    return value.slice(0, low);
}
function collectSecretValues(map) {
    if (!map || typeof map !== 'object' || Array.isArray(map)) {
        return null;
    }
    const out = [];
    for (const raw of Object.values(map)) {
        if (typeof raw !== 'string') {
            continue;
        }
        const trimmed = raw.trim();
        if (trimmed.length < 6) {
            continue;
        }
        out.push(trimmed);
        if (out.length >= 32) {
            break;
        }
    }
    return out.length ? out : null;
}
function buildSshNextActions(jobId) {
    if (!jobId) {
        return [];
    }
    return [
        { tool: 'job', action: 'follow_job', args: { job_id: jobId, timeout_ms: 600000, lines: 120 } },
        { tool: 'job', action: 'tail_job', args: { job_id: jobId, lines: 120 } },
        { tool: 'job', action: 'job_cancel', args: { job_id: jobId } },
    ];
}
function buildGenericEnvelope({ toolName, invokedAs, actionName, toolResult, meta, payload, artifactContext, artifactJson }) {
    return {
        success: toolResult && typeof toolResult === 'object' && typeof toolResult.success === 'boolean'
            ? toolResult.success
            : Boolean(payload?.ok ?? true),
        tool: presentToolName({ tool: toolName, invokedAs }),
        action: actionName || null,
        result: redactObject(toolResult, { maxString: 20 * 1024 }),
        duration_ms: meta?.duration_ms ?? null,
        artifact_uri_context: artifactContext?.uri ?? null,
        artifact_uri_json: artifactJson?.uri ?? null,
        trace: {
            trace_id: meta?.trace_id ?? null,
            span_id: meta?.span_id ?? null,
            parent_span_id: meta?.parent_span_id ?? null,
        },
    };
}
function buildSshExecEnvelope({ actionName, toolResult, meta, args, artifactJson }) {
    const jobId = typeof toolResult?.job_id === 'string' && toolResult.job_id.trim().length
        ? toolResult.job_id.trim()
        : null;
    const isFollow = Boolean(toolResult
        && typeof toolResult === 'object'
        && Object.prototype.hasOwnProperty.call(toolResult, 'start')
        && Object.prototype.hasOwnProperty.call(toolResult, 'wait'));
    const mode = actionName === 'exec_detached' || toolResult?.detached === true || Boolean(jobId)
        ? 'detached'
        : 'sync';
    const exitCode = mode === 'sync'
        ? (Number.isFinite(toolResult?.exitCode) ? Number(toolResult.exitCode) : null)
        : (Number.isFinite(toolResult?.status?.exit_code) ? Number(toolResult.status.exit_code) : null);
    const requestedTimeoutMs = toolResult?.requested_timeout_ms ?? args?.timeout_ms ?? null;
    const timedOut = mode === 'sync'
        ? Boolean(toolResult?.timedOut || toolResult?.hardTimedOut)
        : (isFollow
            ? Boolean(toolResult?.wait?.timed_out)
            : Boolean(toolResult?.timedOut || toolResult?.hardTimedOut));
    const durationMs = meta?.duration_ms ?? toolResult?.duration_ms ?? null;
    const extraSecretValues = collectSecretValues(args?.env);
    const redactionOptions = extraSecretValues
        ? { extraSecretValues, maxString: Number.POSITIVE_INFINITY }
        : { maxString: Number.POSITIVE_INFINITY };
    const stdoutRaw = mode === 'sync'
        ? String(toolResult?.stdout ?? '')
        : (isFollow ? String(toolResult?.logs?.text ?? '') : String(toolResult?.stdout ?? ''));
    const stderrRaw = mode === 'sync' ? String(toolResult?.stderr ?? '') : String(toolResult?.stderr ?? '');
    const stdoutRedacted = redactText(stdoutRaw, redactionOptions);
    const stderrRedacted = redactText(stderrRaw, redactionOptions);
    const stdoutBound = truncateUtf8Prefix(stdoutRedacted, 32 * 1024);
    const stderrBound = truncateUtf8Prefix(stderrRedacted, 16 * 1024);
    const stdoutBytes = mode === 'sync' && Number.isFinite(toolResult?.stdout_bytes) ? Number(toolResult.stdout_bytes) : 0;
    const stderrBytes = mode === 'sync' && Number.isFinite(toolResult?.stderr_bytes) ? Number(toolResult.stderr_bytes) : 0;
    const stdoutTruncated = mode === 'sync'
        ? Boolean(toolResult?.stdout_truncated || toolResult?.stdout_inline_truncated || stdoutBound.length < stdoutRedacted.length)
        : false;
    const stderrTruncated = mode === 'sync'
        ? Boolean(toolResult?.stderr_truncated || toolResult?.stderr_inline_truncated || stderrBound.length < stderrRedacted.length)
        : false;
    const success = typeof toolResult?.success === 'boolean'
        ? toolResult.success
        : (exitCode === 0 && !timedOut);
    const waitCompleted = mode === 'detached' && isFollow ? toolResult?.wait?.completed : null;
    const waitWaitedMs = mode === 'detached' && isFollow ? toolResult?.wait?.waited_ms : null;
    const summary = (mode === 'sync' && typeof durationMs === 'number' && exitCode !== null)
        ? `exit ${exitCode}, ${durationMs}ms`
        : (mode === 'detached' && exitCode !== null && waitCompleted === true && typeof durationMs === 'number')
            ? `exit ${exitCode} (follow), ${durationMs}ms`
            : (mode === 'detached' && timedOut === true && typeof waitWaitedMs === 'number')
                ? `running (follow timed out after ${waitWaitedMs}ms)`
                : (typeof durationMs === 'number' ? `detached, ${durationMs}ms` : (exitCode !== null ? `exit ${exitCode}` : 'detached'));
    const nextActions = buildSshNextActions(jobId);
    const stdoutUri = toolResult?.stdout_ref?.uri;
    const stderrUri = toolResult?.stderr_ref?.uri;
    if (mode === 'sync') {
        if (stdoutTruncated && typeof stdoutUri === 'string' && stdoutUri.trim().length) {
            nextActions.push({ tool: 'artifacts', action: 'tail', args: { uri: stdoutUri.trim(), max_bytes: 64 * 1024 } });
        }
        if (stderrTruncated && typeof stderrUri === 'string' && stderrUri.trim().length) {
            nextActions.push({ tool: 'artifacts', action: 'tail', args: { uri: stderrUri.trim(), max_bytes: 64 * 1024 } });
        }
    }
    return {
        success,
        tool: 'ssh',
        action: actionName || 'exec',
        mode,
        exit_code: exitCode,
        timed_out: timedOut,
        duration_ms: typeof durationMs === 'number' ? durationMs : 0,
        stdout: stdoutBound,
        stderr: stderrBound,
        stdout_bytes: stdoutBytes,
        stderr_bytes: stderrBytes,
        stdout_truncated: stdoutTruncated,
        stderr_truncated: stderrTruncated,
        job_id: mode === 'detached' ? jobId : null,
        wait: mode === 'detached' && isFollow ? redactObject(toolResult?.wait ?? null, { maxString: 8 * 1024 }) : null,
        status: mode === 'detached' && isFollow ? redactObject(toolResult?.status ?? null, { maxString: 8 * 1024 }) : null,
        next_actions: nextActions,
        trace: {
            trace_id: meta?.trace_id ?? null,
            span_id: meta?.span_id ?? null,
            parent_span_id: meta?.parent_span_id ?? null,
        },
        summary,
        artifact_uri_json: artifactJson?.uri ?? null,
    };
}
function buildRepoExecEnvelope({ actionName, toolResult, meta, args, artifactJson }) {
    const exitCode = Number.isFinite(toolResult?.exit_code) ? Number(toolResult.exit_code) : null;
    const durationMs = meta?.duration_ms ?? toolResult?.duration_ms ?? 0;
    const timedOut = Boolean(toolResult?.timed_out);
    const extraSecretValues = collectSecretValues(args?.env);
    const redactionOptions = extraSecretValues
        ? { extraSecretValues, maxString: Number.POSITIVE_INFINITY }
        : { maxString: Number.POSITIVE_INFINITY };
    const stdoutRaw = String(toolResult?.stdout_inline ?? '');
    const stderrRaw = String(toolResult?.stderr_inline ?? '');
    const stdoutRedacted = redactText(stdoutRaw, redactionOptions);
    const stderrRedacted = redactText(stderrRaw, redactionOptions);
    const stdoutBound = truncateUtf8Prefix(stdoutRedacted, 32 * 1024);
    const stderrBound = truncateUtf8Prefix(stderrRedacted, 16 * 1024);
    const stdoutBytes = Number.isFinite(toolResult?.stdout_bytes) ? Number(toolResult.stdout_bytes) : 0;
    const stderrBytes = Number.isFinite(toolResult?.stderr_bytes) ? Number(toolResult.stderr_bytes) : 0;
    const stdoutTruncated = Boolean(toolResult?.stdout_truncated || toolResult?.stdout_inline_truncated || stdoutBound.length < stdoutRedacted.length);
    const stderrTruncated = Boolean(toolResult?.stderr_truncated || toolResult?.stderr_inline_truncated || stderrBound.length < stderrRedacted.length);
    const success = typeof toolResult?.success === 'boolean'
        ? toolResult.success
        : (exitCode === 0 && !timedOut);
    const nextActions = [];
    const stdoutUri = toolResult?.stdout_ref?.uri;
    const stderrUri = toolResult?.stderr_ref?.uri;
    if (stdoutTruncated && typeof stdoutUri === 'string' && stdoutUri.trim().length) {
        nextActions.push({ tool: 'artifacts', action: 'tail', args: { uri: stdoutUri.trim(), max_bytes: 64 * 1024 } });
    }
    if (stderrTruncated && typeof stderrUri === 'string' && stderrUri.trim().length) {
        nextActions.push({ tool: 'artifacts', action: 'tail', args: { uri: stderrUri.trim(), max_bytes: 64 * 1024 } });
    }
    const summary = exitCode !== null
        ? `exit ${exitCode}, ${durationMs}ms`
        : `exit ?, ${durationMs}ms`;
    return {
        success,
        tool: 'repo',
        action: actionName || 'exec',
        mode: 'sync',
        exit_code: exitCode,
        timed_out: timedOut,
        duration_ms: typeof durationMs === 'number' ? durationMs : 0,
        stdout: stdoutBound,
        stderr: stderrBound,
        stdout_bytes: stdoutBytes,
        stderr_bytes: stderrBytes,
        stdout_truncated: stdoutTruncated,
        stderr_truncated: stderrTruncated,
        job_id: null,
        next_actions: nextActions,
        trace: {
            trace_id: meta?.trace_id ?? null,
            span_id: meta?.span_id ?? null,
            parent_span_id: meta?.parent_span_id ?? null,
        },
        summary,
        artifact_uri_json: artifactJson?.uri ?? null,
    };
}
function buildLocalExecEnvelope({ actionName, toolResult, meta, args, artifactJson }) {
    const exitCode = Number.isFinite(toolResult?.exit_code) ? Number(toolResult.exit_code) : null;
    const durationMs = meta?.duration_ms ?? toolResult?.duration_ms ?? 0;
    const timedOut = Boolean(toolResult?.timed_out);
    const extraSecretValues = collectSecretValues(args?.env);
    const redactionOptions = extraSecretValues
        ? { extraSecretValues, maxString: Number.POSITIVE_INFINITY }
        : { maxString: Number.POSITIVE_INFINITY };
    const stdoutRaw = String(toolResult?.stdout ?? '');
    const stderrRaw = String(toolResult?.stderr ?? '');
    const stdoutRedacted = redactText(stdoutRaw, redactionOptions);
    const stderrRedacted = redactText(stderrRaw, redactionOptions);
    const stdoutBound = truncateUtf8Prefix(stdoutRedacted, 32 * 1024);
    const stderrBound = truncateUtf8Prefix(stderrRedacted, 16 * 1024);
    const stdoutBytes = Number.isFinite(toolResult?.stdout_bytes) ? Number(toolResult.stdout_bytes) : 0;
    const stderrBytes = Number.isFinite(toolResult?.stderr_bytes) ? Number(toolResult.stderr_bytes) : 0;
    const stdoutTruncated = Boolean(toolResult?.stdout_inline_truncated || stdoutBound.length < stdoutRedacted.length);
    const stderrTruncated = Boolean(toolResult?.stderr_inline_truncated || stderrBound.length < stderrRedacted.length);
    const success = typeof toolResult?.success === 'boolean'
        ? toolResult.success
        : (exitCode === 0 && !timedOut);
    const nextActions = [];
    const stdoutPath = toolResult?.stdout_path;
    const stderrPath = toolResult?.stderr_path;
    if (stdoutTruncated && typeof stdoutPath === 'string' && stdoutPath.trim().length) {
        nextActions.push({ tool: 'local', action: 'fs_read', args: { path: stdoutPath.trim(), encoding: 'utf8', offset: 0, length: 64 * 1024 } });
    }
    if (stderrTruncated && typeof stderrPath === 'string' && stderrPath.trim().length) {
        nextActions.push({ tool: 'local', action: 'fs_read', args: { path: stderrPath.trim(), encoding: 'utf8', offset: 0, length: 64 * 1024 } });
    }
    const summary = exitCode !== null
        ? `exit ${exitCode}, ${durationMs}ms`
        : `exit ?, ${durationMs}ms`;
    return {
        success,
        tool: 'local',
        action: actionName || 'exec',
        mode: 'sync',
        exit_code: exitCode,
        timed_out: timedOut,
        duration_ms: typeof durationMs === 'number' ? durationMs : 0,
        stdout: stdoutBound,
        stderr: stderrBound,
        stdout_bytes: stdoutBytes,
        stderr_bytes: stderrBytes,
        stdout_truncated: stdoutTruncated,
        stderr_truncated: stderrTruncated,
        job_id: null,
        next_actions: nextActions,
        trace: {
            trace_id: meta?.trace_id ?? null,
            span_id: meta?.span_id ?? null,
            parent_span_id: meta?.parent_span_id ?? null,
        },
        summary,
        artifact_uri_json: artifactJson?.uri ?? null,
    };
}
function resolveToolTier() {
    const raw = String(process.env.SENTRYFROGG_TOOL_TIER || process.env.SF_TOOL_TIER || 'full')
        .trim()
        .toLowerCase();
    return raw === 'core' ? 'core' : 'full';
}
function filterToolCatalogForTier(tools, tier) {
    if (tier !== 'core') {
        return tools;
    }
    return tools.filter((tool) => CORE_TOOL_NAMES.has(tool.name));
}
const outputSchema = {
    type: 'object',
    description: 'Output shaping (path/pick/omit/map).',
    properties: {
        path: { type: 'string' },
        pick: { type: 'array', items: { type: 'string' } },
        omit: { type: 'array', items: { type: 'string' } },
        map: { type: 'object' },
        missing: { type: 'string', enum: ['error', 'empty', 'null', 'undefined'] },
        default: { type: ['string', 'number', 'boolean', 'object', 'array', 'null'] },
    },
    additionalProperties: true,
};
const toolCatalog = [
    {
        name: 'help',
        description: 'Краткая справка по использованию SentryFrogg MCP сервера и доступным инструментам.',
        inputSchema: {
            type: 'object',
            properties: {
                tool: {
                    type: 'string',
                    description: 'Название инструмента для детализации. Оставьте пустым для общего описания.',
                },
                action: {
                    type: 'string',
                    description: 'Опционально: конкретный action внутри инструмента (например, exec/profile_upsert).',
                },
                query: {
                    type: 'string',
                    description: 'Поиск по инструментам/alias/action/полям. Пример: { query: \"ssh exec\" }',
                },
                limit: {
                    type: 'integer',
                    description: 'Максимум результатов для query (по умолчанию 20).',
                },
                output: outputSchema,
                store_as: { type: ['string', 'object'] },
                store_scope: { type: 'string', enum: ['session', 'persistent'] },
                trace_id: { type: 'string' },
                span_id: { type: 'string' },
                parent_span_id: { type: 'string' },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'legend',
        description: 'Семантическая легенда: что значат общие поля и как SentryFrogg разрешает project/target/profile/preset/alias.',
        inputSchema: {
            type: 'object',
            properties: {
                output: outputSchema,
                store_as: { type: ['string', 'object'] },
                store_scope: { type: 'string', enum: ['session', 'persistent'] },
                trace_id: { type: 'string' },
                span_id: { type: 'string' },
                parent_span_id: { type: 'string' },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'mcp_state',
        description: 'Session/persistent state store for cross-tool workflows.',
        inputSchema: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['set', 'get', 'list', 'unset', 'clear', 'dump'] },
                key: { type: 'string' },
                value: {},
                scope: { type: 'string', enum: ['session', 'persistent', 'any'] },
                prefix: { type: 'string' },
                include_values: { type: 'boolean' },
                output: outputSchema,
                store_as: { type: ['string', 'object'] },
                store_scope: { type: 'string', enum: ['session', 'persistent'] },
                trace_id: { type: 'string' },
                span_id: { type: 'string' },
                parent_span_id: { type: 'string' },
                preset: { type: 'string' },
                preset_name: { type: 'string' },
            },
            required: ['action'],
            additionalProperties: false,
        },
    },
    {
        name: 'mcp_jobs',
        description: 'Unified job registry: status/wait/logs/cancel/list.',
        inputSchema: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['job_status', 'job_wait', 'job_logs_tail', 'tail_job', 'follow_job', 'job_cancel', 'job_forget', 'job_list'],
                },
                job_id: { type: 'string' },
                timeout_ms: { type: 'integer' },
                poll_interval_ms: { type: 'integer' },
                lines: { type: 'integer' },
                signal: { type: 'string' },
                limit: { type: 'integer' },
                status: { type: 'string', enum: ['queued', 'running', 'succeeded', 'failed', 'canceled'] },
                output: outputSchema,
                store_as: { type: ['string', 'object'] },
                store_scope: { type: 'string', enum: ['session', 'persistent'] },
                trace_id: { type: 'string' },
                span_id: { type: 'string' },
                parent_span_id: { type: 'string' },
                preset: { type: 'string' },
                preset_name: { type: 'string' },
            },
            required: ['action'],
            additionalProperties: false,
        },
    },
    {
        name: 'mcp_artifacts',
        description: 'Artifacts: read/list artifact:// refs (bounded by default).',
        inputSchema: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['get', 'head', 'tail', 'list'] },
                uri: { type: 'string' },
                rel: { type: 'string' },
                prefix: { type: 'string' },
                encoding: { type: 'string', enum: ['utf8', 'base64'] },
                include_secrets: { type: 'boolean' },
                offset: { type: 'integer' },
                max_bytes: { type: 'integer' },
                limit: { type: 'integer' },
                output: outputSchema,
                store_as: { type: ['string', 'object'] },
                store_scope: { type: 'string', enum: ['session', 'persistent'] },
                trace_id: { type: 'string' },
                span_id: { type: 'string' },
                parent_span_id: { type: 'string' },
                preset: { type: 'string' },
                preset_name: { type: 'string' },
            },
            required: ['action'],
            additionalProperties: false,
        },
    },
    {
        name: 'mcp_project',
        description: 'Project registry: bind SSH/env profiles to named projects + manage active project.',
        inputSchema: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['project_upsert', 'project_get', 'project_list', 'project_delete', 'project_use', 'project_active', 'project_unuse'] },
                name: { type: 'string' },
                project: { type: 'object' },
                description: { type: 'string' },
                default_target: { type: 'string' },
                targets: { type: 'object' },
                policy_profiles: { type: 'object' },
                scope: { type: 'string', enum: ['session', 'persistent', 'any'] },
                output: outputSchema,
                store_as: { type: ['string', 'object'] },
                store_scope: { type: 'string', enum: ['session', 'persistent'] },
                trace_id: { type: 'string' },
                span_id: { type: 'string' },
                parent_span_id: { type: 'string' },
                preset: { type: 'string' },
                preset_name: { type: 'string' },
            },
            required: ['action'],
            additionalProperties: false,
        },
    },
    {
        name: 'mcp_context',
        description: 'Project context cache: detect runtime signals and summarize project state.',
        inputSchema: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['get', 'refresh', 'summary', 'list', 'stats'] },
                key: { type: 'string' },
                project: { type: 'string' },
                project_name: { type: 'string' },
                target: { type: 'string' },
                project_target: { type: 'string' },
                environment: { type: 'string' },
                cwd: { type: 'string' },
                repo_root: { type: 'string' },
                refresh: { type: 'boolean' },
                output: outputSchema,
                store_as: { type: ['string', 'object'] },
                store_scope: { type: 'string', enum: ['session', 'persistent'] },
                trace_id: { type: 'string' },
                span_id: { type: 'string' },
                parent_span_id: { type: 'string' },
                preset: { type: 'string' },
                preset_name: { type: 'string' },
            },
            required: ['action'],
            additionalProperties: false,
        },
    },
    {
        name: 'mcp_workspace',
        description: 'Unified workspace UX: summary, suggestions, and diagnostics.',
        inputSchema: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['summary', 'suggest', 'diagnose', 'store_status', 'run', 'cleanup', 'stats'] },
                key: { type: 'string' },
                project: { type: 'string' },
                project_name: { type: 'string' },
                target: { type: 'string' },
                project_target: { type: 'string' },
                environment: { type: 'string' },
                cwd: { type: 'string' },
                repo_root: { type: 'string' },
                limit: { type: 'number' },
                include_untagged: { type: 'boolean' },
                name: { type: 'string' },
                runbook: { type: 'object' },
                input: { type: 'object' },
                inputs: { type: 'object' },
                intent: { type: 'object' },
                intent_type: { type: 'string' },
                type: { type: 'string' },
                stop_on_error: { type: 'boolean' },
                template_missing: { type: 'string', enum: ['error', 'empty', 'null', 'undefined'] },
                seed_state: { type: 'object' },
                seed_state_scope: { type: 'string', enum: ['session', 'persistent', 'any'] },
                apply: { type: 'boolean' },
                cleanup: { type: 'boolean' },
                overwrite: { type: 'boolean' },
                include_dirs: { type: 'boolean' },
                output: outputSchema,
                store_as: { type: ['string', 'object'] },
                store_scope: { type: 'string', enum: ['session', 'persistent'] },
                trace_id: { type: 'string' },
                span_id: { type: 'string' },
                parent_span_id: { type: 'string' },
                preset: { type: 'string' },
                preset_name: { type: 'string' },
            },
            required: ['action'],
            additionalProperties: false,
        },
    },
    {
        name: 'mcp_env',
        description: 'Encrypted env bundles + safe remote apply via SSH/SFTP.',
        inputSchema: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['profile_upsert', 'profile_get', 'profile_list', 'profile_delete', 'write_remote', 'run_remote'] },
                profile_name: { type: 'string' },
                include_secrets: { type: 'boolean' },
                description: { type: 'string' },
                variables: { type: 'object' },
                env: { type: 'object' },
                data: { type: 'object' },
                secrets: { type: ['object', 'null'] },
                project: { type: 'string' },
                project_name: { type: 'string' },
                target: { type: 'string' },
                project_target: { type: 'string' },
                environment: { type: 'string' },
                ssh_profile_name: { type: 'string' },
                ssh_profile: { type: 'string' },
                env_profile: { type: 'string' },
                vault_profile_name: { type: 'string' },
                vault_profile: { type: 'string' },
                remote_path: { type: 'string' },
                mode: { type: 'integer' },
                mkdirs: { type: 'boolean' },
                overwrite: { type: 'boolean' },
                backup: { type: 'boolean' },
                command: { type: 'string' },
                cwd: { type: 'string' },
                stdin: { type: 'string' },
                timeout_ms: { type: 'integer' },
                pty: { type: ['boolean', 'object'] },
                output: outputSchema,
                store_as: { type: ['string', 'object'] },
                store_scope: { type: 'string', enum: ['session', 'persistent'] },
                trace_id: { type: 'string' },
                span_id: { type: 'string' },
                parent_span_id: { type: 'string' },
                preset: { type: 'string' },
                preset_name: { type: 'string' },
            },
            required: ['action'],
            additionalProperties: false,
        },
    },
    {
        name: 'mcp_vault',
        description: 'HashiCorp Vault: профили + диагностика (KV v2 + AppRole auto-login).',
        inputSchema: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['profile_upsert', 'profile_get', 'profile_list', 'profile_delete', 'profile_test'] },
                profile_name: { type: 'string' },
                include_secrets: { type: 'boolean' },
                addr: { type: 'string' },
                namespace: { type: ['string', 'null'] },
                auth_type: { type: ['string', 'null'] },
                token: { type: ['string', 'null'] },
                role_id: { type: ['string', 'null'] },
                secret_id: { type: ['string', 'null'] },
                timeout_ms: { type: 'integer' },
                output: outputSchema,
                store_as: { type: ['string', 'object'] },
                store_scope: { type: 'string', enum: ['session', 'persistent'] },
                trace_id: { type: 'string' },
                span_id: { type: 'string' },
                parent_span_id: { type: 'string' },
                preset: { type: 'string' },
                preset_name: { type: 'string' },
            },
            required: ['action'],
            additionalProperties: false,
        },
    },
    {
        name: 'mcp_runbook',
        description: 'Runbooks: store, list, and execute multi-step workflows.',
        inputSchema: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['runbook_upsert', 'runbook_upsert_dsl', 'runbook_get', 'runbook_list', 'runbook_delete', 'runbook_run', 'runbook_run_dsl', 'runbook_compile'] },
                name: { type: 'string' },
                runbook: { type: 'object' },
                dsl: { type: 'string' },
                text: { type: 'string' },
                input: { type: 'object' },
                seed_state: { type: 'object' },
                seed_state_scope: { type: 'string', enum: ['session', 'persistent'] },
                stop_on_error: { type: 'boolean' },
                template_missing: { type: 'string', enum: ['error', 'empty', 'null', 'undefined'] },
                output: outputSchema,
                store_as: { type: ['string', 'object'] },
                store_scope: { type: 'string', enum: ['session', 'persistent'] },
                trace_id: { type: 'string' },
                span_id: { type: 'string' },
                parent_span_id: { type: 'string' },
                preset: { type: 'string' },
                preset_name: { type: 'string' },
            },
            required: ['action'],
            additionalProperties: false,
        },
    },
    {
        name: 'mcp_capability',
        description: 'Capability registry for intent→runbook mappings.',
        inputSchema: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['list', 'get', 'set', 'delete', 'resolve', 'suggest', 'graph', 'stats'] },
                name: { type: 'string' },
                intent: { type: 'string' },
                capability: { type: 'object' },
                project: { type: 'string' },
                project_name: { type: 'string' },
                target: { type: 'string' },
                project_target: { type: 'string' },
                environment: { type: 'string' },
                cwd: { type: 'string' },
                repo_root: { type: 'string' },
                output: outputSchema,
                store_as: { type: ['string', 'object'] },
                store_scope: { type: 'string', enum: ['session', 'persistent'] },
                trace_id: { type: 'string' },
                span_id: { type: 'string' },
                parent_span_id: { type: 'string' },
                preset: { type: 'string' },
                preset_name: { type: 'string' },
            },
            required: ['action'],
            additionalProperties: false,
        },
    },
    {
        name: 'mcp_intent',
        description: 'Intent compiler/executor (intent → plan → runbook).',
        inputSchema: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['compile', 'dry_run', 'execute', 'explain'] },
                intent: { type: 'object' },
                apply: { type: 'boolean' },
                project: { type: 'string' },
                project_name: { type: 'string' },
                target: { type: 'string' },
                project_target: { type: 'string' },
                environment: { type: 'string' },
                cwd: { type: 'string' },
                repo_root: { type: 'string' },
                context_key: { type: 'string' },
                context_refresh: { type: 'boolean' },
                stop_on_error: { type: 'boolean' },
                template_missing: { type: 'string', enum: ['error', 'empty', 'null', 'undefined'] },
                save_evidence: { type: 'boolean' },
                output: outputSchema,
                store_as: { type: ['string', 'object'] },
                store_scope: { type: 'string', enum: ['session', 'persistent'] },
                trace_id: { type: 'string' },
                span_id: { type: 'string' },
                parent_span_id: { type: 'string' },
                preset: { type: 'string' },
                preset_name: { type: 'string' },
            },
            required: ['action'],
            additionalProperties: false,
        },
    },
    {
        name: 'mcp_evidence',
        description: 'Evidence bundles produced by intent executions.',
        inputSchema: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['list', 'get'] },
                id: { type: 'string' },
                limit: { type: 'integer' },
                output: outputSchema,
                store_as: { type: ['string', 'object'] },
                store_scope: { type: 'string', enum: ['session', 'persistent'] },
                trace_id: { type: 'string' },
                span_id: { type: 'string' },
                parent_span_id: { type: 'string' },
                preset: { type: 'string' },
                preset_name: { type: 'string' },
            },
            required: ['action'],
            additionalProperties: false,
        },
    },
    {
        name: 'mcp_alias',
        description: 'Alias registry for short names and reusable tool shortcuts.',
        inputSchema: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['alias_upsert', 'alias_get', 'alias_list', 'alias_delete', 'alias_resolve'] },
                name: { type: 'string' },
                alias: { type: 'object' },
                tool: { type: 'string' },
                args: { type: 'object' },
                preset: { type: 'string' },
                description: { type: 'string' },
                output: outputSchema,
                store_as: { type: ['string', 'object'] },
                store_scope: { type: 'string', enum: ['session', 'persistent'] },
                trace_id: { type: 'string' },
                span_id: { type: 'string' },
                parent_span_id: { type: 'string' },
            },
            required: ['action'],
            additionalProperties: false,
        },
    },
    {
        name: 'mcp_preset',
        description: 'Preset registry for reusable tool arguments.',
        inputSchema: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['preset_upsert', 'preset_get', 'preset_list', 'preset_delete'] },
                tool: { type: 'string' },
                name: { type: 'string' },
                preset: { type: 'object' },
                output: outputSchema,
                store_as: { type: ['string', 'object'] },
                store_scope: { type: 'string', enum: ['session', 'persistent'] },
                trace_id: { type: 'string' },
                span_id: { type: 'string' },
                parent_span_id: { type: 'string' },
            },
            required: ['action'],
            additionalProperties: false,
        },
    },
    {
        name: 'mcp_audit',
        description: 'Audit log access with filtering and tail support.',
        inputSchema: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['audit_list', 'audit_tail', 'audit_clear', 'audit_stats'] },
                limit: { type: 'integer' },
                offset: { type: 'integer' },
                reverse: { type: 'boolean' },
                trace_id: { type: 'string' },
                tool: { type: 'string' },
                audit_action: { type: 'string' },
                status: { type: 'string', enum: ['ok', 'error'] },
                since: { type: 'string' },
                output: outputSchema,
                store_as: { type: ['string', 'object'] },
                store_scope: { type: 'string', enum: ['session', 'persistent'] },
                trace_id: { type: 'string' },
                span_id: { type: 'string' },
                parent_span_id: { type: 'string' },
            },
            required: ['action'],
            additionalProperties: false,
        },
    },
    {
        name: 'mcp_pipeline',
        description: 'Streaming pipelines between HTTP, SFTP, and PostgreSQL.',
        inputSchema: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['run', 'describe', 'deploy_smoke'] },
                flow: { type: 'string', enum: ['http_to_sftp', 'sftp_to_http', 'http_to_postgres', 'sftp_to_postgres', 'postgres_to_sftp', 'postgres_to_http'] },
                project: { type: 'string' },
                project_name: { type: 'string' },
                target: { type: 'string' },
                project_target: { type: 'string' },
                environment: { type: 'string' },
                vault_profile_name: { type: 'string' },
                vault_profile: { type: 'string' },
                // deploy_smoke
                local_path: { type: 'string' },
                remote_path: { type: 'string' },
                url: { type: 'string' },
                restart: { type: 'string' },
                restart_command: { type: 'string' },
                overwrite: { type: 'boolean' },
                mkdirs: { type: 'boolean' },
                preserve_mtime: { type: 'boolean' },
                expect_code: { type: 'integer' },
                follow_redirects: { type: 'boolean' },
                insecure_ok: { type: 'boolean' },
                max_bytes: { type: 'integer' },
                settle_ms: { type: 'integer' },
                smoke_attempts: { type: 'integer' },
                smoke_delay_ms: { type: 'integer' },
                smoke_timeout_ms: { type: 'integer' },
                http: { type: 'object' },
                sftp: { type: 'object' },
                postgres: { type: 'object' },
                format: { type: 'string', enum: ['jsonl', 'csv'] },
                batch_size: { type: 'integer' },
                max_rows: { type: 'integer' },
                limit: { type: 'integer' },
                offset: { type: 'integer' },
                columns: { type: 'array', items: { type: 'string' } },
                columns_sql: { type: 'string' },
                order_by: { type: 'array' },
                order_by_sql: { type: 'string' },
                filters: { type: 'object' },
                where_sql: { type: 'string' },
                where_params: { type: 'array' },
                timeout_ms: { type: 'integer' },
                csv_header: { type: 'boolean' },
                csv_delimiter: { type: 'string' },
                cache: { type: 'object' },
                output: outputSchema,
                store_as: { type: ['string', 'object'] },
                store_scope: { type: 'string', enum: ['session', 'persistent'] },
                trace_id: { type: 'string' },
                span_id: { type: 'string' },
                parent_span_id: { type: 'string' },
                preset: { type: 'string' },
                preset_name: { type: 'string' },
            },
            required: ['action'],
            additionalProperties: false,
        },
    },
    {
        name: 'mcp_repo',
        description: 'Safe-by-default repo runner: sandboxed git/render/diff/patch with allowlisted exec (no shell).',
        inputSchema: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['repo_info', 'assert_clean', 'git_diff', 'render', 'apply_patch', 'git_commit', 'git_revert', 'git_push', 'exec'] },
                project: { type: 'string' },
                project_name: { type: 'string' },
                target: { type: 'string' },
                project_target: { type: 'string' },
                environment: { type: 'string' },
                repo_root: { type: 'string' },
                cwd: { type: 'string' },
                apply: { type: 'boolean' },
                // exec
                command: { type: 'string' },
                args: { type: 'array', items: { type: 'string' } },
                env: { type: 'object' },
                stdin: { type: 'string' },
                timeout_ms: { type: 'integer' },
                inline: { type: 'boolean' },
                max_bytes: { type: 'integer' },
                // patch/commit/push
                patch: { type: 'string' },
                message: { type: 'string' },
                remote: { type: 'string' },
                branch: { type: 'string' },
                // revert
                sha: { type: 'string' },
                mainline: { type: 'integer' },
                // render
                render_type: { type: 'string', enum: ['plain', 'kustomize', 'helm'] },
                overlay: { type: 'string' },
                chart: { type: 'string' },
                values: { type: 'array', items: { type: 'string' } },
                output: outputSchema,
                store_as: { type: ['string', 'object'] },
                store_scope: { type: 'string', enum: ['session', 'persistent'] },
                trace_id: { type: 'string' },
                span_id: { type: 'string' },
                parent_span_id: { type: 'string' },
                preset: { type: 'string' },
                preset_name: { type: 'string' },
            },
            required: ['action'],
            additionalProperties: false,
        },
    },
    {
        name: 'mcp_psql_manager',
        description: 'PostgreSQL toolchain. Profile actions + query/batch/transaction + CRUD + select/count/exists/export helpers.',
        inputSchema: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['profile_upsert', 'profile_get', 'profile_list', 'profile_delete', 'profile_test', 'query', 'batch', 'transaction', 'insert', 'insert_bulk', 'update', 'delete', 'select', 'count', 'exists', 'export', 'catalog_tables', 'catalog_columns', 'database_info'] },
                profile_name: { type: 'string' },
                include_secrets: { type: 'boolean' },
                connection: { type: 'object' },
                connection_url: { type: 'string' },
                project: { type: 'string' },
                project_name: { type: 'string' },
                target: { type: 'string' },
                project_target: { type: 'string' },
                environment: { type: 'string' },
                vault_profile_name: { type: 'string' },
                vault_profile: { type: 'string' },
                pool: { type: 'object' },
                options: { type: 'object' },
                sql: { type: 'string' },
                params: { type: 'array', items: { type: ['string', 'number', 'boolean', 'null'] } },
                mode: { type: 'string', enum: ['rows', 'row', 'value', 'command'] },
                timeout_ms: { type: 'integer' },
                statements: { type: 'array', items: { type: 'object' } },
                transactional: { type: 'boolean' },
                table: { type: 'string' },
                schema: { type: 'string' },
                columns: { type: ['array', 'string'] },
                columns_sql: { type: 'string' },
                order_by: { type: ['array', 'object', 'string'] },
                order_by_sql: { type: 'string' },
                limit: { type: 'integer' },
                offset: { type: 'integer' },
                data: { type: 'object' },
                rows: { type: 'array' },
                filters: { type: ['object', 'array'] },
                where_sql: { type: 'string' },
                where_params: { type: 'array', items: { type: ['string', 'number', 'boolean', 'null'] } },
                returning: { type: ['boolean', 'array', 'string'] },
                file_path: { type: 'string' },
                overwrite: { type: 'boolean' },
                format: { type: 'string', enum: ['csv', 'jsonl'] },
                batch_size: { type: 'integer' },
                output: outputSchema,
                store_as: { type: ['string', 'object'] },
                store_scope: { type: 'string', enum: ['session', 'persistent'] },
                trace_id: { type: 'string' },
                span_id: { type: 'string' },
                parent_span_id: { type: 'string' },
                preset: { type: 'string' },
                preset_name: { type: 'string' },
            },
            required: ['action'],
            additionalProperties: false
        }
    },
    {
        name: 'mcp_ssh_manager',
        description: 'SSH executor with profiles, exec/batch diagnostics, and SFTP helpers.',
        inputSchema: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['profile_upsert', 'profile_get', 'profile_list', 'profile_delete', 'profile_test', 'authorized_keys_add', 'exec', 'exec_detached', 'exec_follow', 'deploy_file', 'job_status', 'job_wait', 'job_logs_tail', 'tail_job', 'follow_job', 'job_kill', 'job_forget', 'batch', 'system_info', 'check_host', 'sftp_list', 'sftp_exists', 'sftp_upload', 'sftp_download'] },
                profile_name: { type: 'string' },
                include_secrets: { type: 'boolean' },
                connection: { type: 'object' },
                project: { type: 'string' },
                project_name: { type: 'string' },
                target: { type: 'string' },
                project_target: { type: 'string' },
                environment: { type: 'string' },
                vault_profile_name: { type: 'string' },
                vault_profile: { type: 'string' },
                host_key_policy: { type: 'string', enum: ['accept', 'tofu', 'pin'] },
                host_key_fingerprint_sha256: { type: 'string' },
                public_key: { type: 'string' },
                public_key_path: { type: 'string' },
                authorized_keys_path: { type: 'string' },
                command: { type: 'string' },
                restart: { type: 'string' },
                restart_command: { type: 'string' },
                cwd: { type: 'string' },
                env: { type: 'object' },
                stdin: { type: 'string' },
                job_id: { type: 'string' },
                pid: { type: 'integer' },
                log_path: { type: 'string' },
                pid_path: { type: 'string' },
                exit_path: { type: 'string' },
                signal: { type: 'string' },
                lines: { type: 'integer' },
                poll_interval_ms: { type: 'integer' },
                timeout_ms: { type: 'integer' },
                start_timeout_ms: { type: 'integer' },
                pty: { type: ['boolean', 'object'] },
                commands: { type: 'array', items: { type: 'object' } },
                parallel: { type: 'boolean' },
                stop_on_error: { type: 'boolean' },
                path: { type: 'string' },
                remote_path: { type: 'string' },
                local_path: { type: 'string' },
                recursive: { type: 'boolean' },
                max_depth: { type: 'integer' },
                overwrite: { type: 'boolean' },
                mkdirs: { type: 'boolean' },
                preserve_mtime: { type: 'boolean' },
                output: outputSchema,
                store_as: { type: ['string', 'object'] },
                store_scope: { type: 'string', enum: ['session', 'persistent'] },
                trace_id: { type: 'string' },
                span_id: { type: 'string' },
                parent_span_id: { type: 'string' },
                preset: { type: 'string' },
                preset_name: { type: 'string' },
            },
            required: ['action'],
            additionalProperties: false
        }
    },
    {
        name: 'mcp_api_client',
        description: 'HTTP client with profiles, auth providers, retry/backoff, pagination, and downloads.',
        inputSchema: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['profile_upsert', 'profile_get', 'profile_list', 'profile_delete', 'request', 'paginate', 'download', 'check', 'smoke_http'] },
                profile_name: { type: 'string' },
                include_secrets: { type: 'boolean' },
                project: { type: 'string' },
                project_name: { type: 'string' },
                target: { type: 'string' },
                project_target: { type: 'string' },
                environment: { type: 'string' },
                vault_profile_name: { type: 'string' },
                vault_profile: { type: 'string' },
                base_url: { type: 'string' },
                url: { type: 'string' },
                path: { type: 'string' },
                query: { type: ['object', 'string'] },
                method: { type: 'string' },
                headers: { type: 'object' },
                auth: { type: ['string', 'object'] },
                auth_provider: { type: 'object' },
                body: { type: ['object', 'string', 'number', 'boolean', 'null'] },
                data: { type: ['object', 'string', 'number', 'boolean', 'null'] },
                body_type: { type: 'string' },
                body_base64: { type: 'string' },
                form: { type: 'object' },
                expect_code: { type: 'integer' },
                follow_redirects: { type: 'boolean' },
                insecure_ok: { type: 'boolean' },
                max_bytes: { type: 'integer' },
                timeout_ms: { type: 'integer' },
                response_type: { type: 'string' },
                redirect: { type: 'string' },
                retry: { type: 'object' },
                pagination: { type: 'object' },
                cache: { type: ['boolean', 'object'] },
                download_path: { type: 'string' },
                overwrite: { type: 'boolean' },
                output: outputSchema,
                store_as: { type: ['string', 'object'] },
                store_scope: { type: 'string', enum: ['session', 'persistent'] },
                trace_id: { type: 'string' },
                span_id: { type: 'string' },
                parent_span_id: { type: 'string' },
                preset: { type: 'string' },
                preset_name: { type: 'string' },
            },
            required: ['action'],
            additionalProperties: false
        }
    }
];
if (isUnsafeLocalEnabled()) {
    toolCatalog.push({
        name: 'mcp_local',
        description: 'UNSAFE local machine access: exec and filesystem helpers (requires SENTRYFROGG_UNSAFE_LOCAL=1).',
        inputSchema: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['exec', 'batch', 'fs_read', 'fs_write', 'fs_list', 'fs_stat', 'fs_mkdir', 'fs_rm'] },
                command: { type: 'string' },
                args: { type: 'array' },
                shell: { type: ['boolean', 'string'] },
                cwd: { type: 'string' },
                env: { type: 'object' },
                stdin: { type: 'string' },
                timeout_ms: { type: 'integer' },
                inline: { type: 'boolean' },
                commands: { type: 'array', items: { type: 'object' } },
                parallel: { type: 'boolean' },
                stop_on_error: { type: 'boolean' },
                path: { type: 'string' },
                encoding: { type: 'string' },
                offset: { type: 'integer' },
                length: { type: 'integer' },
                content: {},
                content_base64: { type: 'string' },
                overwrite: { type: 'boolean' },
                mode: { type: 'integer' },
                recursive: { type: 'boolean' },
                max_depth: { type: 'integer' },
                with_stats: { type: 'boolean' },
                force: { type: 'boolean' },
                output: outputSchema,
                store_as: { type: ['string', 'object'] },
                store_scope: { type: 'string', enum: ['session', 'persistent'] },
                trace_id: { type: 'string' },
                span_id: { type: 'string' },
                parent_span_id: { type: 'string' },
                preset: { type: 'string' },
                preset_name: { type: 'string' },
            },
            required: ['action'],
            additionalProperties: false,
        },
    });
}
const toolByName = Object.fromEntries(toolCatalog.map((tool) => [tool.name, tool]));
toolCatalog.push({ name: 'sql', description: 'Alias for mcp_psql_manager.', inputSchema: toolByName.mcp_psql_manager.inputSchema }, { name: 'psql', description: 'Alias for mcp_psql_manager.', inputSchema: toolByName.mcp_psql_manager.inputSchema }, { name: 'ssh', description: 'Alias for mcp_ssh_manager.', inputSchema: toolByName.mcp_ssh_manager.inputSchema }, { name: 'job', description: 'Alias for mcp_jobs.', inputSchema: toolByName.mcp_jobs.inputSchema }, { name: 'artifacts', description: 'Alias for mcp_artifacts.', inputSchema: toolByName.mcp_artifacts.inputSchema }, { name: 'http', description: 'Alias for mcp_api_client.', inputSchema: toolByName.mcp_api_client.inputSchema }, { name: 'api', description: 'Alias for mcp_api_client.', inputSchema: toolByName.mcp_api_client.inputSchema }, { name: 'repo', description: 'Alias for mcp_repo.', inputSchema: toolByName.mcp_repo.inputSchema }, { name: 'state', description: 'Alias for mcp_state.', inputSchema: toolByName.mcp_state.inputSchema }, { name: 'project', description: 'Alias for mcp_project.', inputSchema: toolByName.mcp_project.inputSchema }, { name: 'context', description: 'Alias for mcp_context.', inputSchema: toolByName.mcp_context.inputSchema }, { name: 'workspace', description: 'Alias for mcp_workspace.', inputSchema: toolByName.mcp_workspace.inputSchema }, { name: 'env', description: 'Alias for mcp_env.', inputSchema: toolByName.mcp_env.inputSchema }, { name: 'vault', description: 'Alias for mcp_vault.', inputSchema: toolByName.mcp_vault.inputSchema }, { name: 'runbook', description: 'Alias for mcp_runbook.', inputSchema: toolByName.mcp_runbook.inputSchema }, { name: 'capability', description: 'Alias for mcp_capability.', inputSchema: toolByName.mcp_capability.inputSchema }, { name: 'intent', description: 'Alias for mcp_intent.', inputSchema: toolByName.mcp_intent.inputSchema }, { name: 'evidence', description: 'Alias for mcp_evidence.', inputSchema: toolByName.mcp_evidence.inputSchema }, { name: 'alias', description: 'Alias for mcp_alias.', inputSchema: toolByName.mcp_alias.inputSchema }, { name: 'preset', description: 'Alias for mcp_preset.', inputSchema: toolByName.mcp_preset.inputSchema }, { name: 'audit', description: 'Alias for mcp_audit.', inputSchema: toolByName.mcp_audit.inputSchema }, { name: 'pipeline', description: 'Alias for mcp_pipeline.', inputSchema: toolByName.mcp_pipeline.inputSchema });
if (toolByName.mcp_local) {
    toolCatalog.push({ name: 'local', description: 'Alias for mcp_local.', inputSchema: toolByName.mcp_local.inputSchema });
}
const ajv = new Ajv({ allErrors: true, strict: false });
const validatorByTool = new Map();
function decodeJsonPointer(pointer) {
    if (!pointer || typeof pointer !== 'string') {
        return [];
    }
    const raw = pointer.startsWith('#') ? pointer.slice(1) : pointer;
    if (!raw || raw === '/') {
        return [];
    }
    return raw
        .split('/')
        .filter(Boolean)
        .map((token) => token.replace(/~1/g, '/').replace(/~0/g, '~'));
}
function schemaNodeAt(schema, schemaPath) {
    const tokens = decodeJsonPointer(schemaPath);
    let current = schema;
    for (const token of tokens) {
        if (!current || typeof current !== 'object') {
            return undefined;
        }
        current = current[token];
    }
    return current;
}
function schemaParentAt(schema, schemaPath) {
    const tokens = decodeJsonPointer(schemaPath);
    if (tokens.length === 0) {
        return { node: schema, key: null };
    }
    const key = tokens[tokens.length - 1];
    const parentTokens = tokens.slice(0, -1);
    let current = schema;
    for (const token of parentTokens) {
        if (!current || typeof current !== 'object') {
            return { node: undefined, key };
        }
        current = current[token];
    }
    return { node: current, key };
}
function formatJsonOneLine(value) {
    try {
        return JSON.stringify(value);
    }
    catch (error) {
        return null;
    }
}
function primaryToolAlias(toolName) {
    switch (toolName) {
        case 'mcp_ssh_manager':
            return 'ssh';
        case 'mcp_psql_manager':
            return 'psql';
        case 'mcp_api_client':
            return 'api';
        case 'mcp_repo':
            return 'repo';
        case 'mcp_state':
            return 'state';
        case 'mcp_project':
            return 'project';
        case 'mcp_context':
            return 'context';
        case 'mcp_workspace':
            return 'workspace';
        case 'mcp_jobs':
            return 'job';
        case 'mcp_artifacts':
            return 'artifacts';
        case 'mcp_env':
            return 'env';
        case 'mcp_vault':
            return 'vault';
        case 'mcp_runbook':
            return 'runbook';
        case 'mcp_capability':
            return 'capability';
        case 'mcp_intent':
            return 'intent';
        case 'mcp_evidence':
            return 'evidence';
        case 'mcp_alias':
            return 'alias';
        case 'mcp_preset':
            return 'preset';
        case 'mcp_audit':
            return 'audit';
        case 'mcp_pipeline':
            return 'pipeline';
        case 'mcp_local':
            return 'local';
        default:
            return null;
    }
}
function buildHelpHint({ toolName, actionName }) {
    const alias = primaryToolAlias(toolName) || toolName;
    if (!actionName) {
        return `help({ tool: '${alias}' })`;
    }
    return `help({ tool: '${alias}', action: '${actionName}' })`;
}
function buildToolExample(toolName, actionName) {
    if (!toolName || !actionName) {
        return null;
    }
    if (toolName === 'mcp_ssh_manager') {
        switch (actionName) {
            case 'profile_upsert':
                return {
                    action: 'profile_upsert',
                    profile_name: 'my-ssh',
                    connection: { host: 'example.com', port: 22, username: 'root', private_key_path: '~/.ssh/id_ed25519', host_key_policy: 'tofu' },
                };
            case 'authorized_keys_add':
                return {
                    action: 'authorized_keys_add',
                    target: 'prod',
                    public_key_path: '~/.ssh/id_ed25519.pub',
                };
            case 'exec':
                return {
                    action: 'exec',
                    target: 'prod',
                    command: 'uname -a',
                };
            case 'exec_follow':
                return {
                    action: 'exec_follow',
                    target: 'prod',
                    command: 'sleep 60 && echo done',
                    timeout_ms: 600000,
                    lines: 120,
                };
            case 'exec_detached':
                return {
                    action: 'exec_detached',
                    target: 'prod',
                    command: 'sleep 60 && echo done',
                    log_path: '/tmp/sentryfrogg-detached.log',
                };
            case 'deploy_file':
                return {
                    action: 'deploy_file',
                    target: 'prod',
                    local_path: './build/app.bin',
                    remote_path: '/opt/myapp/app.bin',
                    overwrite: true,
                    restart: 'myapp',
                };
            case 'tail_job':
                return {
                    action: 'tail_job',
                    job_id: '<job_id>',
                    lines: 120,
                };
            default:
                return { action: actionName };
        }
    }
    if (toolName === 'mcp_project') {
        switch (actionName) {
            case 'project_upsert':
                return {
                    action: 'project_upsert',
                    name: 'myapp',
                    project: {
                        default_target: 'prod',
                        targets: {
                            prod: {
                                ssh_profile: 'myapp-prod-ssh',
                                env_profile: 'myapp-prod-env',
                                postgres_profile: 'myapp-prod-db',
                                api_profile: 'myapp-prod-api',
                                cwd: '/opt/myapp',
                                env_path: '/opt/myapp/.env',
                            },
                        },
                    },
                };
            case 'project_use':
                return { action: 'project_use', name: 'myapp', scope: 'persistent' };
            default:
                return { action: actionName };
        }
    }
    if (toolName === 'mcp_context') {
        switch (actionName) {
            case 'summary':
                return { action: 'summary', project: 'myapp', target: 'prod' };
            case 'refresh':
                return { action: 'refresh', cwd: '/srv/myapp' };
            default:
                return { action: actionName };
        }
    }
    if (toolName === 'mcp_workspace') {
        switch (actionName) {
            case 'summary':
                return { action: 'summary', project: 'myapp', target: 'prod' };
            case 'diagnose':
                return { action: 'diagnose' };
            case 'run':
                return { action: 'run', intent_type: 'k8s.diff', inputs: { overlay: '/repo/overlays/prod' } };
            case 'cleanup':
                return { action: 'cleanup' };
            default:
                return { action: actionName };
        }
    }
    if (toolName === 'mcp_env') {
        switch (actionName) {
            case 'profile_upsert':
                return {
                    action: 'profile_upsert',
                    profile_name: 'myapp-prod-env',
                    secrets: { DATABASE_URL: 'ref:vault:kv2:secret/myapp/prod#DATABASE_URL' },
                };
            case 'write_remote':
                return { action: 'write_remote', target: 'prod', overwrite: false, backup: true };
            case 'run_remote':
                return { action: 'run_remote', target: 'prod', command: 'printenv | head' };
            default:
                return { action: actionName };
        }
    }
    if (toolName === 'mcp_vault') {
        switch (actionName) {
            case 'profile_upsert':
                return {
                    action: 'profile_upsert',
                    profile_name: 'corp-vault',
                    addr: 'https://vault.example.com',
                    namespace: 'team-a',
                    auth_type: 'approle',
                    role_id: '<role_id>',
                    secret_id: '<secret_id>',
                };
            case 'profile_test':
                return { action: 'profile_test', profile_name: 'corp-vault' };
            default:
                return { action: actionName };
        }
    }
    if (toolName === 'mcp_psql_manager') {
        switch (actionName) {
            case 'query':
                return { action: 'query', target: 'prod', sql: 'SELECT 1' };
            default:
                return { action: actionName };
        }
    }
    if (toolName === 'mcp_api_client') {
        switch (actionName) {
            case 'request':
                return { action: 'request', target: 'prod', method: 'GET', url: '/health' };
            case 'smoke_http':
                return { action: 'smoke_http', url: 'https://example.com/healthz', expect_code: 200, follow_redirects: true, insecure_ok: true };
            default:
                return { action: actionName };
        }
    }
    if (toolName === 'mcp_repo') {
        switch (actionName) {
            case 'repo_info':
                return { action: 'repo_info', repo_root: '/repo' };
            case 'assert_clean':
                return { action: 'assert_clean', repo_root: '/repo' };
            case 'exec':
                return { action: 'exec', repo_root: '/repo', command: 'git', args: ['status', '--short'] };
            case 'apply_patch':
                return {
                    action: 'apply_patch',
                    repo_root: '/repo',
                    apply: true,
                    patch: [
                        '*** Begin Patch',
                        '*** Add File: hello.txt',
                        '+Hello',
                        '*** End Patch',
                    ].join('\n') + '\n',
                };
            case 'git_commit':
                return { action: 'git_commit', repo_root: '/repo', apply: true, message: 'chore(gitops): update manifests' };
            case 'git_revert':
                return { action: 'git_revert', repo_root: '/repo', apply: true, sha: 'HEAD' };
            case 'git_push':
                return { action: 'git_push', repo_root: '/repo', apply: true, remote: 'origin', branch: 'sf/gitops/update-123' };
            default:
                return { action: actionName, repo_root: '/repo' };
        }
    }
    if (toolName === 'mcp_artifacts') {
        switch (actionName) {
            case 'get':
                return { action: 'get', uri: 'artifact://runs/<trace>/tool_calls/<span>/result.json', max_bytes: 16384, encoding: 'utf8' };
            case 'head':
                return { action: 'head', uri: 'artifact://runs/<trace>/tool_calls/<span>/stdout.log', max_bytes: 16384, encoding: 'utf8' };
            case 'tail':
                return { action: 'tail', uri: 'artifact://runs/<trace>/tool_calls/<span>/stdout.log', max_bytes: 16384, encoding: 'utf8' };
            case 'list':
                return { action: 'list', prefix: 'runs/<trace>/tool_calls/<span>/', limit: 50 };
            default:
                return { action: actionName };
        }
    }
    if (toolName === 'mcp_jobs') {
        switch (actionName) {
            case 'follow_job':
                return { action: 'follow_job', job_id: '<job_id>', timeout_ms: 600000, lines: 120 };
            case 'tail_job':
                return { action: 'tail_job', job_id: '<job_id>', lines: 120 };
            case 'job_status':
                return { action: 'job_status', job_id: '<job_id>' };
            case 'job_cancel':
                return { action: 'job_cancel', job_id: '<job_id>' };
            default:
                return { action: actionName };
        }
    }
    if (toolName === 'mcp_intent') {
        switch (actionName) {
            case 'compile':
                return { action: 'compile', intent: { type: 'k8s.diff', inputs: { overlay: '/repo/overlay' } } };
            case 'execute':
                return { action: 'execute', apply: true, intent: { type: 'k8s.apply', inputs: { overlay: '/repo/overlay' } } };
            default:
                return { action: actionName };
        }
    }
    return { action: actionName };
}
function formatSchemaErrors({ toolName, args, errors, schema }) {
    if (!Array.isArray(errors) || errors.length === 0) {
        return 'Invalid arguments';
    }
    const payload = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
    const action = typeof payload.action === 'string' ? payload.action : null;
    const header = `Invalid arguments for ${toolName}${action ? `:${action}` : ''}`;
    const rendered = [];
    const hints = [];
    const didYouMeans = [];
    let suggestedAction = null;
    for (const err of errors.slice(0, 10)) {
        const at = err.instancePath ? err.instancePath : '(root)';
        if (err.keyword === 'additionalProperties' && err.params && err.params.additionalProperty) {
            const unknown = String(err.params.additionalProperty);
            rendered.push(`${at}: unknown field '${unknown}'`);
            const parent = schemaParentAt(schema, err.schemaPath);
            const props = parent?.node?.properties && typeof parent.node.properties === 'object'
                ? Object.keys(parent.node.properties)
                : [];
            const suggestions = suggest(unknown, props, { limit: 3 });
            if (suggestions.length > 0) {
                didYouMeans.push(`field '${unknown}': ${suggestions.join(', ')}`);
            }
            continue;
        }
        if (err.keyword === 'enum' && err.params && Array.isArray(err.params.allowedValues)) {
            const allowed = err.params.allowedValues.map(String);
            const received = schemaNodeAt(payload, err.instancePath);
            const receivedStr = received === undefined ? '' : String(received);
            rendered.push(`${at}: expected one of ${allowed.slice(0, 12).join(', ')}${allowed.length > 12 ? ', ...' : ''}`);
            const suggestions = suggest(receivedStr, allowed, { limit: 3 });
            if (suggestions.length > 0) {
                didYouMeans.push(`${at}: ${suggestions.join(', ')}`);
                if (err.instancePath === '/action') {
                    suggestedAction = suggestions[0];
                }
            }
            continue;
        }
        if (err.keyword === 'required' && err.params && err.params.missingProperty) {
            rendered.push(`${at}: missing required field '${err.params.missingProperty}'`);
            continue;
        }
        if (err.keyword === 'type' && err.params && err.params.type) {
            rendered.push(`${at}: expected ${err.params.type}`);
            continue;
        }
        rendered.push(`${at}: ${err.message || err.keyword}`);
    }
    const helpAction = suggestedAction || action;
    hints.push(`Hint: ${buildHelpHint({ toolName, actionName: helpAction })}`);
    const example = buildToolExample(toolName, helpAction);
    const exampleText = example ? formatJsonOneLine(example) : null;
    if (exampleText) {
        hints.push(`Example: ${exampleText}`);
    }
    const lines = [header];
    lines.push(...rendered.map((line) => `- ${line}`));
    if (didYouMeans.length > 0) {
        lines.push(`Did you mean: ${didYouMeans.slice(0, 3).join(' | ')}`);
    }
    lines.push(...hints);
    return lines.join('\n');
}
function assertToolArgsValid(toolName, args) {
    const canonical = HELP_TOOL_ALIASES[toolName] || toolName;
    const tool = toolByName[canonical];
    if (!tool || !tool.inputSchema) {
        return;
    }
    const payload = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
    let validate = validatorByTool.get(canonical);
    if (!validate) {
        validate = ajv.compile(tool.inputSchema);
        validatorByTool.set(canonical, validate);
    }
    if (!validate(payload)) {
        throw new McpError(ErrorCode.InvalidParams, formatSchemaErrors({
            toolName: canonical,
            args: payload,
            errors: validate.errors,
            schema: tool.inputSchema,
        }));
    }
}
function normalizeJsonSchemaForOpenAI(schema) {
    if (schema === null || schema === undefined) {
        return schema;
    }
    if (typeof schema !== 'object') {
        return schema;
    }
    if (Array.isArray(schema)) {
        return schema.map((item) => normalizeJsonSchemaForOpenAI(item));
    }
    const out = { ...schema };
    if (out.properties && typeof out.properties === 'object') {
        out.properties = Object.fromEntries(Object.entries(out.properties).map(([key, value]) => [key, normalizeJsonSchemaForOpenAI(value)]));
    }
    if (out.items !== undefined) {
        out.items = normalizeJsonSchemaForOpenAI(out.items);
    }
    if (out.additionalProperties && typeof out.additionalProperties === 'object') {
        out.additionalProperties = normalizeJsonSchemaForOpenAI(out.additionalProperties);
    }
    for (const keyword of ['anyOf', 'oneOf', 'allOf']) {
        if (Array.isArray(out[keyword])) {
            out[keyword] = out[keyword].map((sub) => normalizeJsonSchemaForOpenAI(sub));
        }
    }
    if (Array.isArray(out.type)) {
        const types = out.type.slice();
        delete out.type;
        const shared = { ...out };
        delete shared.items;
        return {
            ...shared,
            anyOf: types.map((t) => {
                if (t === 'array') {
                    return { type: 'array', items: out.items ?? {} };
                }
                return { type: t };
            }),
        };
    }
    if (out.type === 'array' && out.items === undefined) {
        out.items = {};
    }
    return out;
}
const TOOL_SEMANTIC_FIELDS = new Set([
    'output',
    'store_as',
    'store_scope',
    'trace_id',
    'span_id',
    'parent_span_id',
    'preset',
    'preset_name',
    'response_mode',
]);
function stripToolSemanticFields(schema) {
    if (!schema || typeof schema !== 'object') {
        return schema;
    }
    if (!schema.properties || typeof schema.properties !== 'object') {
        return schema;
    }
    const out = { ...schema, properties: { ...schema.properties } };
    for (const key of TOOL_SEMANTIC_FIELDS) {
        delete out.properties[key];
    }
    if (Array.isArray(out.required)) {
        out.required = out.required.filter((key) => !TOOL_SEMANTIC_FIELDS.has(key));
    }
    return out;
}
const DEFAULT_CONTEXT_REPO_ROOT = '/home/amir/Документы/projects/context';
function isDirectory(candidate) {
    if (!candidate) {
        return false;
    }
    try {
        return fsSync.existsSync(candidate) && fsSync.statSync(candidate).isDirectory();
    }
    catch (error) {
        return false;
    }
}
function resolveContextRepoRoot() {
    const explicit = process.env.SENTRYFROGG_CONTEXT_REPO_ROOT || process.env.SF_CONTEXT_REPO_ROOT;
    if (explicit) {
        return isDirectory(explicit) ? explicit : null;
    }
    return isDirectory(DEFAULT_CONTEXT_REPO_ROOT) ? DEFAULT_CONTEXT_REPO_ROOT : null;
}
function asString(value) {
    if (value === null || value === undefined) {
        return String(value);
    }
    if (typeof value === 'string') {
        return value;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }
    if (Buffer.isBuffer(value)) {
        return `[buffer:${value.length}]`;
    }
    if (Array.isArray(value)) {
        return `[array:${value.length}]`;
    }
    if (typeof value === 'object') {
        const keys = Object.keys(value);
        const shown = keys.slice(0, 6);
        const suffix = keys.length > shown.length ? ', ...' : '';
        return `{${shown.join(', ')}${suffix}}`;
    }
    return String(value);
}
function compactValue(value, options = {}, depth = 0) {
    const config = {
        maxDepth: Number.isFinite(options.maxDepth) ? options.maxDepth : 6,
        maxArray: Number.isFinite(options.maxArray) ? options.maxArray : 50,
        maxKeys: Number.isFinite(options.maxKeys) ? options.maxKeys : 50,
    };
    if (value === null || value === undefined) {
        return value;
    }
    if (typeof value !== 'object') {
        return value;
    }
    if (Buffer.isBuffer(value)) {
        return `[buffer:${value.length}]`;
    }
    if (depth >= config.maxDepth) {
        if (Array.isArray(value)) {
            return `[array:${value.length}]`;
        }
        return '[object]';
    }
    if (Array.isArray(value)) {
        const slice = value.slice(0, config.maxArray).map((item) => compactValue(item, config, depth + 1));
        if (value.length > config.maxArray) {
            slice.push(`[... +${value.length - config.maxArray} more]`);
        }
        return slice;
    }
    const keys = Object.keys(value);
    const limited = keys.slice(0, config.maxKeys);
    const out = {};
    for (const key of limited) {
        out[key] = compactValue(value[key], config, depth + 1);
    }
    if (keys.length > config.maxKeys) {
        out.__more_keys__ = keys.length - config.maxKeys;
    }
    return out;
}
function collectArtifactRefs(value, options = {}) {
    const maxRefs = Number.isFinite(options.maxRefs) ? options.maxRefs : 25;
    const maxDepth = Number.isFinite(options.maxDepth) ? options.maxDepth : 10;
    const refs = [];
    const seen = new Set();
    const stack = [{ value, depth: 0 }];
    while (stack.length > 0 && refs.length < maxRefs) {
        const current = stack.pop();
        if (!current) {
            continue;
        }
        const node = current.value;
        const depth = current.depth;
        if (typeof node === 'string') {
            const trimmed = node.trim();
            if (trimmed.startsWith('artifact://') && !seen.has(trimmed)) {
                seen.add(trimmed);
                refs.push(trimmed);
            }
            continue;
        }
        if (!node || typeof node !== 'object' || Buffer.isBuffer(node)) {
            continue;
        }
        if (depth >= maxDepth) {
            continue;
        }
        if (Array.isArray(node)) {
            for (let idx = node.length - 1; idx >= 0; idx -= 1) {
                stack.push({ value: node[idx], depth: depth + 1 });
            }
            continue;
        }
        const values = Object.values(node);
        for (let idx = values.length - 1; idx >= 0; idx -= 1) {
            stack.push({ value: values[idx], depth: depth + 1 });
        }
    }
    return refs;
}
function buildContextHeaderLegend() {
    return [
        '[LEGEND]',
        'A = Answer line (1–3 lines max).',
        'R = Reference anchor.',
        'C = Command to verify/reproduce.',
        'E = Error (typed, actionable).',
        'M = Continuation marker (cursor/more).',
        'N = Note.',
        '',
    ];
}
function formatContextDoc(lines) {
    return `${lines.join('\n').trim()}\n`;
}
function formatToolErrorMessage(tool, error) {
    const lines = [
        'SentryFroggError',
        `tool: ${tool}`,
        `kind: ${error.kind}`,
        `code: ${error.code}`,
        `retryable: ${error.retryable === true}`,
        `message: ${error.message}`,
    ];
    if (error.hint) {
        lines.push(`hint: ${error.hint}`);
    }
    return lines.join('\n');
}
function mapToolErrorToMcpError(tool, error) {
    if (!ToolError.isToolError(error)) {
        return new McpError(ErrorCode.InternalError, `Ошибка выполнения ${tool}: ${error?.message || String(error)}`);
    }
    const message = formatToolErrorMessage(tool, error);
    switch (error.kind) {
        case 'invalid_params':
            return new McpError(ErrorCode.InvalidParams, message);
        case 'timeout':
            return new McpError(ErrorCode.RequestTimeout, message);
        case 'denied':
        case 'conflict':
        case 'not_found':
            return new McpError(ErrorCode.InvalidRequest, message);
        case 'retryable':
            return new McpError(ErrorCode.InternalError, message);
        case 'internal':
        default:
            return new McpError(ErrorCode.InternalError, message);
    }
}
function formatHelpResultToContext(result) {
    const lines = buildContextHeaderLegend();
    lines.push('[CONTENT]');
    if (!result || typeof result !== 'object') {
        lines.push(`A: help`);
        lines.push(`N: invalid help payload (${typeof result})`);
        return formatContextDoc(lines);
    }
    if (result.error) {
        lines.push(`E: ${result.error}`);
        if (Array.isArray(result.known_tools)) {
            lines.push(`N: known_tools: ${result.known_tools.join(', ')}`);
        }
        if (result.hint) {
            lines.push(`N: hint: ${result.hint}`);
        }
        return formatContextDoc(lines);
    }
    if (result.query && Array.isArray(result.results)) {
        lines.push(`A: help({ query: ${JSON.stringify(result.query)} })`);
        if (result.hint) {
            lines.push(`N: hint: ${result.hint}`);
        }
        if (Array.isArray(result.did_you_mean) && result.did_you_mean.length > 0) {
            lines.push(`N: did_you_mean: ${result.did_you_mean.join(', ')}`);
        }
        lines.push('');
        lines.push('Results:');
        for (const entry of result.results) {
            if (!entry || typeof entry !== 'object') {
                continue;
            }
            const kind = entry.kind ? String(entry.kind) : 'item';
            if (kind === 'action') {
                const tool = entry.tool ? String(entry.tool) : '';
                const action = entry.action ? String(entry.action) : '';
                lines.push(`- action: ${tool}:${action}`);
                continue;
            }
            if (kind === 'field') {
                const tool = entry.tool ? String(entry.tool) : '';
                const field = entry.field ? String(entry.field) : '';
                lines.push(`- field: ${tool}.${field}`);
                continue;
            }
            if (kind === 'tool_alias') {
                lines.push(`- tool_alias: ${entry.alias} → ${entry.tool}`);
                continue;
            }
            if (kind === 'alias') {
                lines.push(`- alias: ${entry.alias} → ${entry.tool}`);
                continue;
            }
            if (kind === 'tool') {
                lines.push(`- tool: ${entry.tool}${entry.alias ? ` (alias: ${entry.alias})` : ''}`);
                continue;
            }
            lines.push(`- ${kind}`);
        }
        return formatContextDoc(lines);
    }
    if (result.name && Array.isArray(result.actions)) {
        lines.push(`A: help({ tool: '${result.name}'${result.action ? ", action: '" + result.action + "'" : ''} })`);
        if (result.description) {
            lines.push(`N: ${result.description}`);
        }
        if (result.usage) {
            lines.push(`N: usage: ${result.usage}`);
        }
        if (Array.isArray(result.actions) && result.actions.length > 0) {
            lines.push('');
            lines.push('Actions:');
            for (const action of result.actions) {
                lines.push(`- ${action}`);
            }
        }
        if (Array.isArray(result.fields) && result.fields.length > 0) {
            lines.push('');
            lines.push('Fields (action-specific payload, excluding semantic fields):');
            for (const field of result.fields) {
                lines.push(`- ${field}`);
            }
        }
        if (result.example && typeof result.example === 'object') {
            lines.push('');
            lines.push('Example:');
            lines.push('```json');
            lines.push(JSON.stringify(result.example, null, 2));
            lines.push('```');
        }
        if (Array.isArray(result.examples) && result.examples.length > 0) {
            lines.push('');
            lines.push('Templates:');
            for (const entry of result.examples.slice(0, 5)) {
                if (!entry || typeof entry !== 'object') {
                    continue;
                }
                if (!entry.example || typeof entry.example !== 'object') {
                    continue;
                }
                lines.push(`- ${entry.action}`);
            }
        }
        if (result.legend_hint) {
            lines.push('');
            lines.push(`N: ${result.legend_hint}`);
        }
        return formatContextDoc(lines);
    }
    lines.push('A: help()');
    if (result.overview) {
        lines.push(`N: ${result.overview}`);
    }
    if (result.usage) {
        lines.push(`N: usage: ${result.usage}`);
    }
    if (result.legend?.hint) {
        lines.push(`N: ${result.legend.hint}`);
    }
    if (Array.isArray(result.tools)) {
        lines.push('');
        lines.push('Tools:');
        for (const tool of result.tools) {
            if (!tool || typeof tool !== 'object') {
                continue;
            }
            const actions = Array.isArray(tool.actions) && tool.actions.length > 0
                ? ` (actions: ${tool.actions.slice(0, 12).join(', ')}${tool.actions.length > 12 ? ', ...' : ''})`
                : '';
            lines.push(`- ${tool.name}: ${tool.description}${actions}`);
        }
    }
    return formatContextDoc(lines);
}
function formatLegendResultToContext(result) {
    const lines = buildContextHeaderLegend();
    lines.push('[CONTENT]');
    lines.push('A: legend()');
    if (!result || typeof result !== 'object') {
        lines.push(`E: invalid legend payload (${typeof result})`);
        return formatContextDoc(lines);
    }
    if (result.description) {
        lines.push(`N: ${result.description}`);
    }
    if (Array.isArray(result.golden_path)) {
        lines.push('');
        lines.push('Golden path:');
        for (const step of result.golden_path) {
            lines.push(`- ${step}`);
        }
    }
    if (result.common_fields && typeof result.common_fields === 'object') {
        lines.push('');
        lines.push('Common fields:');
        for (const [key, entry] of Object.entries(result.common_fields)) {
            if (!entry || typeof entry !== 'object') {
                continue;
            }
            if (entry.meaning) {
                lines.push(`- ${key}: ${entry.meaning}`);
            }
        }
    }
    if (result.resolution && typeof result.resolution === 'object') {
        lines.push('');
        lines.push('Resolution:');
        if (Array.isArray(result.resolution.tool_resolution_order)) {
            lines.push('- tool resolution order:');
            for (const step of result.resolution.tool_resolution_order) {
                lines.push(`  - ${step}`);
            }
        }
    }
    if (result.safety && typeof result.safety === 'object') {
        lines.push('');
        lines.push('Safety:');
        for (const [key, entry] of Object.entries(result.safety)) {
            if (!entry || typeof entry !== 'object') {
                continue;
            }
            if (entry.meaning) {
                lines.push(`- ${key}: ${entry.meaning}`);
            }
            if (entry.gate) {
                lines.push(`  - gate: ${entry.gate}`);
            }
            if (Array.isArray(entry.gates)) {
                lines.push(`  - gates: ${entry.gates.join(', ')}`);
            }
        }
    }
    return formatContextDoc(lines);
}
function buildArtifactRef({ traceId, spanId }) {
    const runId = traceId || 'run';
    const callId = spanId || crypto.randomUUID();
    const rel = `runs/${runId}/tool_calls/${callId}.context`;
    return {
        uri: `artifact://${rel}`,
        rel,
    };
}
async function writeContextArtifact(contextRoot, artifact, content) {
    const filePath = path.join(contextRoot, 'artifacts', artifact.rel);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, { encoding: 'utf8' });
    return filePath;
}
function formatGenericResultToContext({ tool, action, result, meta, artifactUri, artifactWriteError }) {
    const lines = ['[CONTENT]'];
    const header = action ? `${tool}.${action}` : tool;
    lines.push(`A: ${header}`);
    if (meta?.duration_ms !== undefined) {
        lines.push(`N: duration_ms: ${meta.duration_ms}`);
    }
    if (meta?.trace_id) {
        lines.push(`N: trace_id: ${meta.trace_id}`);
    }
    if (meta?.span_id) {
        lines.push(`N: span_id: ${meta.span_id}`);
    }
    if (meta?.parent_span_id) {
        lines.push(`N: parent_span_id: ${meta.parent_span_id}`);
    }
    if (meta?.stored_as) {
        lines.push(`N: stored_as: ${meta.stored_as}`);
    }
    if (meta?.invoked_as) {
        lines.push(`N: invoked_as: ${meta.invoked_as}`);
    }
    if (meta?.preset) {
        lines.push(`N: preset: ${meta.preset}`);
    }
    const refDedupe = new Set();
    if (artifactUri) {
        refDedupe.add(artifactUri);
        lines.push(`R: ${artifactUri}`);
    }
    if (artifactWriteError) {
        lines.push(`N: artifact_write_failed: ${artifactWriteError}`);
    }
    const redacted = redactObject(result);
    for (const ref of collectArtifactRefs(redacted)) {
        if (refDedupe.has(ref)) {
            continue;
        }
        refDedupe.add(ref);
        lines.push(`R: ${ref}`);
    }
    const compacted = compactValue(redacted);
    if (compacted === null || compacted === undefined) {
        return formatContextDoc(lines);
    }
    if (typeof compacted !== 'object') {
        lines.push(`N: result: ${asString(compacted)}`);
        return formatContextDoc(lines);
    }
    if (Array.isArray(compacted)) {
        lines.push(`N: result: array (${compacted.length})`);
        lines.push('');
        lines.push('Preview:');
        for (const item of compacted.slice(0, 10)) {
            lines.push(`- ${asString(item)}`);
        }
        return formatContextDoc(lines);
    }
    const keys = Object.keys(compacted);
    lines.push(`N: result: object (keys: ${keys.slice(0, 12).join(', ')}${keys.length > 12 ? ', ...' : ''})`);
    return formatContextDoc(lines);
}
function normalizeToolForOpenAI(tool) {
    const normalized = normalizeJsonSchemaForOpenAI(tool.inputSchema);
    const minimized = stripToolSemanticFields(normalized);
    return {
        ...tool,
        inputSchema: minimized,
    };
}
class SentryFroggServer {
    constructor() {
        this.server = new Server({
            name: 'sentryfrogg',
            version: '7.0.1',
        }, {
            capabilities: {
                tools: { list: true, call: true },
            },
            protocolVersion: '2025-06-18',
        });
        this.container = null;
        this.initialized = false;
    }
    async initialize() {
        try {
            this.container = await ServiceBootstrap.initialize();
            await this.setupHandlers();
            this.initialized = true;
            const logger = this.container.get('logger');
            logger.info('SentryFrogg MCP Server v7.0.1 ready');
        }
        catch (error) {
            process.stderr.write(`Failed to initialize SentryFrogg MCP Server: ${error.message}\n`);
            throw error;
        }
    }
    async setupHandlers() {
        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            const tier = resolveToolTier();
            const visible = filterToolCatalogForTier(toolCatalog, tier);
            return { tools: visible.map(normalizeToolForOpenAI) };
        });
        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const { name } = request.params;
            const rawArgs = request.params.arguments;
            const responseMode = resolveResponseMode(rawArgs);
            let args = stripResponseMode(rawArgs);
            let normalization = null;
            const toolExecutor = this.container.get('toolExecutor');
            try {
                if (isMachineResponseMode(responseMode) && args && typeof args === 'object' && !Array.isArray(args)) {
                    const isExec = args.action === 'exec';
                    const wantsInlineDefault = (name === 'mcp_repo' || name === 'mcp_local') && isExec;
                    if (wantsInlineDefault && !Object.prototype.hasOwnProperty.call(args, 'inline')) {
                        args = { ...args, inline: true };
                    }
                }
                if (args && typeof args === 'object' && !Array.isArray(args)) {
                    const canonical = HELP_TOOL_ALIASES[name] || name;
                    const schemaProps = toolByName[canonical]?.inputSchema?.properties;
                    const allowedKeys = schemaProps && typeof schemaProps === 'object'
                        ? new Set(Object.keys(schemaProps))
                        : null;
                    const normalized = normalizeArgsAliases(args, { tool: canonical, action: args.action, allowedKeys });
                    args = normalized.args;
                    normalization = normalized.normalization;
                }
                assertToolArgsValid(name, args);
                let result;
                let payload;
                const startedAt = Date.now();
                switch (name) {
                    case 'help': {
                        const traceId = args?.trace_id || crypto.randomUUID();
                        const spanId = args?.span_id || crypto.randomUUID();
                        const parentSpanId = args?.parent_span_id;
                        result = await this.handleHelp(args);
                        payload = await toolExecutor.wrapResult({
                            tool: name,
                            args,
                            result,
                            startedAt,
                            traceId,
                            spanId,
                            parentSpanId,
                        });
                        break;
                    }
                    case 'legend': {
                        const traceId = args?.trace_id || crypto.randomUUID();
                        const spanId = args?.span_id || crypto.randomUUID();
                        const parentSpanId = args?.parent_span_id;
                        result = this.handleLegend(args);
                        payload = await toolExecutor.wrapResult({
                            tool: name,
                            args,
                            result,
                            startedAt,
                            traceId,
                            spanId,
                            parentSpanId,
                        });
                        break;
                    }
                    default:
                        payload = await toolExecutor.execute(name, args);
                        break;
                }
                const meta = (payload && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, 'meta'))
                    ? payload.meta
                    : undefined;
                const toolResult = (payload && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, 'result'))
                    ? payload.result
                    : payload;
                const contextRoot = resolveContextRepoRoot();
                let artifactContext = null;
                let artifactJson = null;
                if (contextRoot) {
                    try {
                        artifactContext = buildToolCallContextRef({ traceId: meta?.trace_id, spanId: meta?.span_id });
                        artifactJson = buildToolCallFileRef({ traceId: meta?.trace_id, spanId: meta?.span_id, filename: 'result.json' });
                    }
                    catch (error) {
                        artifactContext = null;
                        artifactJson = null;
                    }
                }
                let artifactWriteError;
                let artifactPath;
                let text;
                let contentMarker = false;
                const toolName = meta?.tool || name;
                const actionName = meta?.action || args?.action;
                if (toolName === 'help') {
                    if (toolResult &&
                        typeof toolResult === 'object' &&
                        toolResult.name === 'legend' &&
                        toolResult.common_fields &&
                        toolResult.resolution) {
                        text = formatLegendResultToContext(toolResult);
                    }
                    else {
                        text = formatHelpResultToContext(toolResult);
                    }
                }
                else if (toolName === 'legend') {
                    text = formatLegendResultToContext(toolResult);
                }
                else {
                    text = formatGenericResultToContext({
                        tool: toolName,
                        action: actionName,
                        result: toolResult,
                        meta,
                        artifactUri: artifactContext?.uri,
                    });
                }
                if (artifactContext && contextRoot) {
                    try {
                        const written = await writeTextArtifact(contextRoot, artifactContext, text);
                        artifactPath = written.path;
                    }
                    catch (error) {
                        artifactWriteError = error?.message || String(error);
                    }
                    if (artifactWriteError) {
                        if (toolName === 'help') {
                            text = `${text}N: artifact_write_failed: ${artifactWriteError}\n`;
                        }
                        else if (toolName === 'legend') {
                            text = `${text}N: artifact_write_failed: ${artifactWriteError}\n`;
                        }
                        else {
                            text = formatGenericResultToContext({
                                tool: toolName,
                                action: actionName,
                                result: toolResult,
                                meta,
                                artifactUri: artifactContext.uri,
                                artifactWriteError,
                            });
                        }
                    }
                    if (text.includes('[CONTENT]\\n')) {
                        contentMarker = true;
                        text = text.replace('[CONTENT]\\n', '[DATA]\\n');
                    }
                    if (artifactPath) {
                        if (!text.includes(`R: ${artifactContext.uri}`)) {
                            if (text.includes('[CONTENT]\\n')) {
                                text = text.replace('[CONTENT]\\n', `[CONTENT]\\nR: ${artifactContext.uri}\\n`);
                            }
                            else {
                                text = text.replace('[DATA]\n', `[DATA]\nR: ${artifactContext.uri}\n`);
                            }
                        }
                        if (!text.includes(`N: artifact_path:`)) {
                            text = `${text}N: artifact_path: ${artifactPath}\n`;
                        }
                    }
                }
                if (contentMarker) {
                    text = text.replace('[DATA]\\n', '[CONTENT]\\n');
                }
                const isSshExec = toolName === 'mcp_ssh_manager'
                    && (actionName === 'exec' || actionName === 'exec_detached' || actionName === 'exec_follow');
                const isRepoExec = toolName === 'mcp_repo' && actionName === 'exec';
                const isLocalExec = toolName === 'mcp_local' && actionName === 'exec';
                const envelope = isSshExec
                    ? buildSshExecEnvelope({ actionName: actionName || 'exec', toolResult, meta, args, artifactJson })
                    : (isRepoExec
                        ? buildRepoExecEnvelope({ actionName: actionName || 'exec', toolResult, meta, args, artifactJson })
                        : (isLocalExec
                            ? buildLocalExecEnvelope({ actionName: actionName || 'exec', toolResult, meta, args, artifactJson })
                            : buildGenericEnvelope({
                                toolName,
                                invokedAs: meta?.invoked_as,
                                actionName,
                                toolResult,
                                meta,
                                payload,
                                artifactContext,
                                artifactJson,
                            })));
                if (normalization && envelope && typeof envelope === 'object') {
                    envelope.normalization = normalization;
                }
                if (artifactJson && contextRoot) {
                    try {
                        await writeTextArtifact(contextRoot, artifactJson, JSON.stringify(envelope));
                    }
                    catch (error) {
                        envelope.artifact_uri_json = null;
                    }
                }
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(envelope),
                        },
                    ],
                };
            }
            catch (error) {
                const logger = this.container?.get('logger');
                logger?.error('Tool execution failed', {
                    tool: name,
                    action: args?.action,
                    error: error.message,
                });
                if (error instanceof McpError) {
                    throw error;
                }
                if (ToolError.isToolError(error)) {
                    throw mapToolErrorToMcpError(name, error);
                }
                throw new McpError(ErrorCode.InternalError, `Ошибка выполнения ${name}: ${error.message}`);
            }
        });
    }
    async handlePostgreSQL(args) {
        this.ensureInitialized();
        return this.container.get('postgresqlManager').handleAction(args);
    }
    async handleSSH(args) {
        this.ensureInitialized();
        return this.container.get('sshManager').handleAction(args);
    }
    async handleAPI(args) {
        this.ensureInitialized();
        return this.container.get('apiManager').handleAction(args);
    }
    buildLegendPayload() {
        const aliases = Object.fromEntries(Object.entries(HELP_TOOL_ALIASES).filter(([, toolName]) => Boolean(toolByName[toolName])));
        return {
            name: 'legend',
            description: 'Каноничная семантика SentryFrogg MCP: общие поля, порядок разрешения и безопасные дефолты.',
            mental_model: [
                'Думайте о SentryFrogg как о «наборе адаптеров + память»: вы вызываете tool+action и получаете результат (который можно дополнительно сформировать через `output` и/или сохранить через `store_as`).',
                "Основная UX-ось: один раз связать `project`+`target` с профилями → дальше вызывать `ssh`/`env`/`psql`/`api` только с `target`.",
            ],
            response: {
                shape: 'По умолчанию инструменты возвращают строгий JSON envelope (для парсинга). Параллельно пишется .context артефакт для человека и `result.json` для машины (если настроен context repo root).',
                tracing: 'Корреляция (`trace_id`/`span_id`/`parent_span_id`) пишется в audit log и логи (stderr). Для просмотра используйте `mcp_audit`.',
            },
            common_fields: {
                action: {
                    meaning: 'Операция внутри инструмента. Почти всегда обязательна (см. `help({tool})` чтобы увидеть enum).',
                    example: { tool: 'mcp_ssh_manager', action: 'exec' },
                },
                output: {
                    meaning: 'Формирует возвращаемое значение (и то, что попадёт в `store_as`).',
                    pipeline: '`path` → `pick` → `omit` → `map`',
                    path_syntax: [
                        'Dot/bracket: `rows[0].id`, `entries[0].trace_id`',
                        'Числа в `[]` считаются индексами массива.',
                    ],
                    missing: {
                        default: '`error` (бросает ошибку)',
                        modes: [
                            '`error` → ошибка, если `path` не найден или `map` ожидает массив',
                            '`null` → вернуть `null`',
                            '`undefined` → вернуть `undefined`',
                            '`empty` → вернуть «пустое значение» (обычно `{}`; если используется `map` — `[]`)',
                        ],
                    },
                    default: {
                        meaning: 'Если `missing` не `error`, можно задать явный `default` (он также участвует в `map`).',
                    },
                },
                store_as: {
                    meaning: 'Сохранить сформированный результат в `mcp_state`.',
                    forms: [
                        '`store_as: \"key\"` + (опционально) `store_scope: \"session\"|\"persistent\"`',
                        '`store_as: { key: \"key\", scope: \"session\"|\"persistent\" }`',
                    ],
                    note: '`session` — дефолт, если scope не указан.',
                },
                preset: {
                    meaning: 'Применить сохранённый preset до мерджа аргументов. Синонимы: `preset` и `preset_name`.',
                    merge_order: [
                        '1) preset.data (по имени)',
                        '2) alias.args (если вызвали алиас)',
                        '3) arguments вызова (побеждают)',
                    ],
                },
                tracing: {
                    meaning: 'Корреляция вызовов для логов/аудита/трасс. Можно прокидывать сверху вниз.',
                    fields: ['`trace_id`', '`span_id`', '`parent_span_id`'],
                },
                response_mode: {
                    meaning: 'Формат ответа на этот tool-call: `ai|compact` (строгий JSON).',
                    values: ['`ai`', '`compact`'],
                    note: '`compact` сейчас эквивалентен `ai` (зарезервировано на будущее). Сервер пишет `result.json` (JSON-артефакт) и возвращает `artifact_uri_json`, если настроен context repo root.',
                },
            },
            resolution: {
                tool_aliases: aliases,
                tool_resolution_order: [
                    'Точное имя инструмента (например, `mcp_ssh_manager`).',
                    'Встроенные алиасы (`ssh`, `psql`, `api`, …).',
                    'Пользовательские алиасы из `mcp_alias` (могут добавлять args/preset).',
                ],
                project: {
                    meaning: 'Именованный набор target-ов, каждый target связывает профили/пути/URL.',
                    resolved_from: ['`project` или `project_name` в аргументах', 'active project из state (`project.active`)'],
                },
                target: {
                    meaning: 'Окружение внутри project (например, `prod`, `stage`).',
                    synonyms: ['`target`', '`project_target`', '`environment`'],
                    selection: [
                        'явно через аргументы (synonyms)',
                        'иначе `project.default_target`',
                        'иначе auto-pick если target ровно один',
                        'иначе ошибка (когда target-ов несколько)',
                    ],
                },
                profile_resolution: {
                    meaning: 'Как выбирается `profile_name`, если вы его не указали.',
                    order: [
                        'если есть inline `connection` → он используется напрямую',
                        'иначе `profile_name` (явно)',
                        'иначе binding из `project.target.*_profile` (если project/target резолвятся)',
                        'иначе auto-pick если профиль ровно один в хранилище этого типа',
                        'иначе ошибка',
                    ],
                },
            },
            refs: {
                env: {
                    scheme: '`ref:env:VAR_NAME`',
                    meaning: 'Подставить значение из переменной окружения (для секретов/паролей/ключей).',
                },
                vault: {
                    scheme: '`ref:vault:...` (например, `ref:vault:kv2:secret/app/prod#TOKEN`)',
                    meaning: 'Подставить значение из HashiCorp Vault (KV v2). Требует выбранного `vault_profile`.',
                },
            },
            safety: {
                secret_export: {
                    meaning: 'Даже если есть `include_secrets: true`, экспорт секретов из профилей включается только break-glass флагом окружения.',
                    gates: ['`SENTRYFROGG_ALLOW_SECRET_EXPORT=1`', '`SF_ALLOW_SECRET_EXPORT=1`'],
                },
                intent_apply: {
                    meaning: 'Intent с write/mixed effects требует `apply: true` (иначе будет ошибка).',
                },
                unsafe_local: {
                    meaning: '`mcp_local` доступен только при включённом unsafe режиме; в обычном режиме он скрыт из `tools/list`.',
                    gate: '`SENTRYFROGG_UNSAFE_LOCAL=1`',
                },
            },
            golden_path: [
                '1) `help()` → увидеть инструменты.',
                '2) `legend()` → понять семантику общих полей и resolution.',
                '3) (опционально) `mcp_project.project_upsert` + `mcp_project.project_use` → связать project/target с профилями.',
                '4) Дальше работать через `ssh`/`env`/`psql`/`api` с `target` и минимальными аргументами.',
            ],
        };
    }
    async handleHelp(args = {}) {
        this.ensureInitialized();
        const rawTool = args.tool ? String(args.tool).trim().toLowerCase() : '';
        const rawAction = args.action ? String(args.action).trim() : '';
        const rawQuery = args.query ? String(args.query).trim() : '';
        const tool = rawTool ? (HELP_TOOL_ALIASES[rawTool] || rawTool) : '';
        const action = rawAction || '';
        const tier = resolveToolTier();
        const limit = Number.isFinite(Number(args.limit)) ? Math.max(1, Math.min(50, Math.floor(Number(args.limit)))) : 20;
        const extractActions = (toolName) => {
            const schema = toolByName[toolName]?.inputSchema;
            const actionEnum = schema?.properties?.action?.enum;
            return Array.isArray(actionEnum) ? actionEnum.slice() : [];
        };
        const extractFields = (toolName) => {
            const schema = toolByName[toolName]?.inputSchema;
            const props = schema?.properties || {};
            const ignored = new Set([
                'action',
                'output',
                'store_as',
                'store_scope',
                'trace_id',
                'span_id',
                'parent_span_id',
                'preset',
                'preset_name',
                'response_mode',
            ]);
            return Object.keys(props).filter((key) => !ignored.has(key));
        };
        const summaries = {
            help: {
                description: 'Показывает справку. Передайте `tool`, чтобы получить детали по инструменту.',
                usage: "call_tool → name: 'help', arguments: { tool?: string, action?: string }",
            },
            legend: {
                description: 'Семантическая легенда: общие поля, порядок resolution, safety-гейты и golden path.',
                usage: "call_tool → name: 'legend' (или help({ tool: 'legend' }))",
            },
            mcp_psql_manager: {
                description: 'PostgreSQL: профили, запросы, транзакции, CRUD, select/count/exists/export + bulk insert.',
                usage: "profile_upsert/profile_list → query/batch/transaction → insert/insert_bulk/update/delete/select/count/exists/export",
            },
            mcp_ssh_manager: {
                description: 'SSH: профили, exec/batch, диагностика и SFTP.',
                usage: "profile_upsert/profile_list → (optional) authorized_keys_add → exec/exec_detached/exec_follow → job_* (tail_job/follow_job) → sftp_* (deploy_file)",
            },
            mcp_api_client: {
                description: 'HTTP: профили, request/paginate/download, retry/backoff, auth providers + cache.',
                usage: "profile_upsert/profile_list → request/paginate/download/check → smoke_http",
            },
            mcp_repo: {
                description: 'Repo: безопасные git/render/diff/patch операции в sandbox + allowlisted exec без shell.',
                usage: 'repo_info/git_diff/render → (apply=true) apply_patch/git_commit/git_revert/git_push → exec',
            },
            mcp_state: {
                description: 'State: переменные между вызовами, поддержка session/persistent.',
                usage: 'set/get/list/unset/clear/dump',
            },
            mcp_project: {
                description: 'Projects: профили, targets и policy profiles для автономных сценариев.',
                usage: 'project_upsert/project_list → project_use → (targets + policy_profiles)',
            },
            mcp_context: {
                description: 'Context: обнаружение сигналов проекта и сводка контекста.',
                usage: 'summary/get → refresh → list/stats',
            },
            mcp_workspace: {
                description: 'Workspace: сводка, подсказки, диагностика.',
                usage: 'summary/suggest → run → cleanup → diagnose → store_status',
            },
            mcp_jobs: {
                description: 'Jobs: единый реестр async задач (status/wait/logs/cancel/list).',
                usage: 'job_status/job_wait/job_logs_tail/tail_job/follow_job/job_cancel/job_forget/job_list',
            },
            mcp_artifacts: {
                description: 'Artifacts: чтение и листинг artifact:// refs (bounded по умолчанию).',
                usage: 'get/head/tail/list',
            },
            mcp_env: {
                description: 'Env: зашифрованные env-бандлы и безопасная запись/запуск на серверах по SSH.',
                usage: 'profile_upsert/profile_list → write_remote/run_remote',
            },
            mcp_vault: {
                description: 'Vault: профили (addr/namespace + token или AppRole) и диагностика (KV v2).',
                usage: 'profile_upsert/profile_list → profile_test',
            },
            mcp_runbook: {
                description: 'Runbooks: хранение и выполнение многошаговых сценариев, плюс DSL.',
                usage: 'runbook_upsert/runbook_upsert_dsl/runbook_list → runbook_run/runbook_run_dsl',
            },
            mcp_capability: {
                description: 'Capabilities: реестр intent→runbook, граф зависимостей и статистика.',
                usage: 'list/get/resolve → set/delete → graph/stats',
            },
            mcp_intent: {
                description: 'Intent: компиляция и выполнение capability-планов с dry-run и evidence.',
                usage: 'compile/explain → dry_run → execute (apply=true для write/mixed)',
            },
            mcp_evidence: {
                description: 'Evidence: просмотр сохранённых evidence-бандлов.',
                usage: 'list/get',
            },
            mcp_alias: {
                description: 'Aliases: короткие имена для инструментов и аргументов.',
                usage: 'alias_upsert/alias_list/alias_get/alias_delete',
            },
            mcp_preset: {
                description: 'Presets: reusable наборы аргументов для инструментов.',
                usage: 'preset_upsert/preset_list/preset_get/preset_delete',
            },
            mcp_audit: {
                description: 'Audit log: просмотр и фильтрация событий.',
                usage: 'audit_list/audit_tail/audit_stats/audit_clear',
            },
            mcp_pipeline: {
                description: 'Pipelines: потоковые HTTP↔SFTP↔PostgreSQL сценарии.',
                usage: 'run/describe/deploy_smoke',
            },
        };
        if (isUnsafeLocalEnabled()) {
            summaries.mcp_local = {
                description: 'Local (UNSAFE): локальные exec и filesystem операции (только при включённом unsafe режиме).',
                usage: 'exec/batch/fs_read/fs_write/fs_list/fs_stat/fs_mkdir/fs_rm',
            };
        }
        const userAliases = [];
        try {
            const aliasService = this.container?.get('aliasService');
            if (aliasService && typeof aliasService.listAliases === 'function') {
                const listed = await aliasService.listAliases();
                const aliases = Array.isArray(listed?.aliases) ? listed.aliases : [];
                for (const entry of aliases) {
                    if (!entry || typeof entry !== 'object') {
                        continue;
                    }
                    if (!entry.name || !entry.tool) {
                        continue;
                    }
                    userAliases.push({
                        name: String(entry.name),
                        tool: String(entry.tool),
                        description: entry.description ? String(entry.description) : undefined,
                    });
                }
            }
        }
        catch (error) {
        }
        if (!tool && rawQuery) {
            const normalizeToken = (value) => String(value ?? '')
                .trim()
                .toLowerCase()
                .replace(/[^\p{L}\p{N}]+/gu, '');
            const levenshtein = (aRaw, bRaw) => {
                const a = String(aRaw ?? '');
                const b = String(bRaw ?? '');
                if (a === b) {
                    return 0;
                }
                const n = a.length;
                const m = b.length;
                if (n === 0) {
                    return m;
                }
                if (m === 0) {
                    return n;
                }
                const prev = new Array(m + 1);
                const curr = new Array(m + 1);
                for (let j = 0; j <= m; j += 1) {
                    prev[j] = j;
                }
                for (let i = 1; i <= n; i += 1) {
                    curr[0] = i;
                    const ai = a.charCodeAt(i - 1);
                    for (let j = 1; j <= m; j += 1) {
                        const cost = ai === b.charCodeAt(j - 1) ? 0 : 1;
                        curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
                    }
                    for (let j = 0; j <= m; j += 1) {
                        prev[j] = curr[j];
                    }
                }
                return prev[m];
            };
            const maxAllowedDistance = (input) => {
                const normalized = normalizeToken(input);
                if (!normalized) {
                    return 0;
                }
                if (normalized.length <= 4) {
                    return 1;
                }
                if (normalized.length <= 8) {
                    return 2;
                }
                return Math.max(3, Math.floor(normalized.length * 0.35));
            };
            const termScore = (term, token) => {
                const t = normalizeToken(term);
                const cand = normalizeToken(token);
                if (!t || !cand) {
                    return Number.POSITIVE_INFINITY;
                }
                if (cand.includes(t)) {
                    return cand.startsWith(t) ? 0 : 1;
                }
                const dist = levenshtein(t, cand);
                const allowed = maxAllowedDistance(t);
                if (dist <= allowed) {
                    return 10 + dist;
                }
                return Number.POSITIVE_INFINITY;
            };
            const terms = rawQuery.split(/\s+/).filter(Boolean).slice(0, 6);
            const tierVisible = tier === 'core'
                ? Object.fromEntries(Object.entries(summaries).filter(([key]) => CORE_TOOL_NAMES.has(key)))
                : summaries;
            const visibleToolNames = new Set(Object.keys(tierVisible));
            const results = [];
            for (const [toolName, summary] of Object.entries(summaries)) {
                const alias = primaryToolAlias(toolName) || null;
                results.push({
                    kind: 'tool',
                    tool: toolName,
                    alias,
                    exposed_in_tools_list: visibleToolNames.has(toolName),
                    description: summary?.description,
                    tokens: [toolName, alias, summary?.description].filter(Boolean),
                });
                const actions = extractActions(toolName);
                for (const actionName of actions) {
                    const display = primaryToolAlias(toolName) || toolName;
                    results.push({
                        kind: 'action',
                        tool: toolName,
                        alias,
                        action: actionName,
                        exposed_in_tools_list: visibleToolNames.has(toolName),
                        hint: buildHelpHint({ toolName, actionName }),
                        tokens: [actionName, `${toolName}.${actionName}`, `${display}.${actionName}`],
                    });
                }
                const fields = extractFields(toolName);
                for (const fieldName of fields) {
                    const display = primaryToolAlias(toolName) || toolName;
                    results.push({
                        kind: 'field',
                        tool: toolName,
                        alias,
                        field: fieldName,
                        exposed_in_tools_list: visibleToolNames.has(toolName),
                        hint: buildHelpHint({ toolName }),
                        tokens: [fieldName, `${toolName}.${fieldName}`, `${display}.${fieldName}`],
                    });
                }
            }
            for (const [aliasName, toolName] of Object.entries(HELP_TOOL_ALIASES)) {
                results.push({
                    kind: 'tool_alias',
                    alias: aliasName,
                    tool: toolName,
                    exposed_in_tools_list: visibleToolNames.has(toolName),
                    hint: buildHelpHint({ toolName }),
                    tokens: [aliasName, toolName],
                });
            }
            for (const entry of userAliases) {
                results.push({
                    kind: 'alias',
                    alias: entry.name,
                    tool: entry.tool,
                    description: entry.description,
                    exposed_in_tools_list: visibleToolNames.has(entry.tool),
                    tokens: [entry.name, entry.tool, entry.description].filter(Boolean),
                });
            }
            const scored = [];
            for (const item of results) {
                const tokens = Array.isArray(item.tokens) ? item.tokens : [];
                let total = 0;
                let ok = true;
                for (const term of terms) {
                    let best = Number.POSITIVE_INFINITY;
                    for (const token of tokens) {
                        const score = termScore(term, token);
                        if (score < best) {
                            best = score;
                        }
                    }
                    if (!Number.isFinite(best)) {
                        ok = false;
                        break;
                    }
                    total += best;
                }
                if (!ok) {
                    continue;
                }
                scored.push({ item, score: total });
            }
            scored.sort((a, b) => a.score - b.score);
            const out = [];
            for (const entry of scored) {
                const item = entry.item;
                if (item.kind === 'action') {
                    item.example = buildToolExample(item.tool, item.action);
                }
                delete item.tokens;
                out.push(item);
                if (out.length >= limit) {
                    break;
                }
            }
            if (out.length === 0) {
                const knownTools = Array.from(new Set([
                    ...Object.keys(summaries),
                    ...Object.keys(HELP_TOOL_ALIASES),
                    ...userAliases.map((a) => a.name),
                ])).sort();
                return {
                    query: rawQuery,
                    limit,
                    results: [],
                    did_you_mean: rawQuery ? suggest(rawQuery, knownTools, { limit: 5 }) : undefined,
                    hint: "Попробуйте: help({ tool: 'ssh' }) или help({ tool: 'ssh', action: 'exec' })",
                };
            }
            return {
                query: rawQuery,
                limit,
                results: out,
                hint: "Для деталей используйте help({ tool: '<tool>', action: '<action>' })",
            };
        }
        if (tool) {
            if (tool === 'legend') {
                return this.buildLegendPayload();
            }
            if (!summaries[tool]) {
                const knownTools = Array.from(new Set([
                    ...Object.keys(summaries),
                    ...Object.keys(HELP_TOOL_ALIASES),
                ])).sort();
                const suggestions = rawTool ? suggest(rawTool, knownTools, { limit: 5 }) : [];
                return {
                    error: `Неизвестный инструмент: ${tool}`,
                    known_tools: knownTools,
                    did_you_mean: suggestions.length > 0 ? suggestions : undefined,
                    hint: "Попробуйте: { tool: 'mcp_ssh_manager' } или { tool: 'ssh' }",
                };
            }
            const actions = extractActions(tool);
            const fields = extractFields(tool);
            const entry = {
                name: tool,
                description: summaries[tool].description,
                usage: summaries[tool].usage,
                actions,
                fields,
                hint: action
                    ? `help({ tool: '${tool}', action: '${action}' })`
                    : `help({ tool: '${tool}', action: '<action>' })`,
            };
            if (action) {
                if (actions.length > 0 && !actions.includes(action)) {
                    const suggestions = suggest(action, actions, { limit: 5 });
                    return {
                        ...entry,
                        error: `Неизвестный action для ${tool}: ${action}`,
                        known_actions: actions,
                        did_you_mean_actions: suggestions.length > 0 ? suggestions : undefined,
                    };
                }
                return {
                    ...entry,
                    action,
                    example: buildToolExample(tool, action),
                };
            }
            const KEY_EXAMPLES = {
                mcp_repo: ['repo_info', 'exec', 'apply_patch'],
                mcp_ssh_manager: ['exec', 'exec_follow', 'deploy_file'],
                mcp_artifacts: ['get', 'list'],
                mcp_jobs: ['follow_job', 'tail_job'],
                mcp_workspace: ['summary', 'suggest', 'run'],
                mcp_context: ['summary', 'refresh'],
                mcp_project: ['project_upsert', 'project_use'],
                mcp_psql_manager: ['query', 'select'],
                mcp_api_client: ['request', 'smoke_http'],
            };
            const chosen = Array.isArray(KEY_EXAMPLES[tool])
                ? KEY_EXAMPLES[tool].filter((act) => actions.includes(act))
                : actions.slice(0, 3);
            const examples = chosen
                .slice(0, 4)
                .map((act) => ({ action: act, example: buildToolExample(tool, act) }))
                .filter((item) => item.example);
            return {
                ...entry,
                examples: examples.length > 0 ? examples : undefined,
                legend_hint: "См. `legend()` для семантики общих полей (`output`, `store_as`, `preset`, `project/target`).",
            };
        }
        const visibleSummaries = tier === 'core'
            ? Object.fromEntries(Object.entries(summaries).filter(([key]) => CORE_TOOL_NAMES.has(key)))
            : summaries;
        const overview = tier === 'core'
            ? 'SentryFrogg MCP (tool_tier=core): используйте workspace/jobs/artifacts (и project опционально); остальные инструменты скрыты из tools/list, но доступны при явном вызове.'
            : (isUnsafeLocalEnabled()
                ? 'SentryFrogg MCP подключает PostgreSQL, SSH, HTTP, state, project, context, runbook, capability/intent/evidence, alias, preset, audit, pipeline и (unsafe) local инструменты.'
                : 'SentryFrogg MCP подключает PostgreSQL, SSH, HTTP, state, project, context, runbook, capability/intent/evidence, alias, preset, audit и pipeline инструменты.');
        return {
            overview,
            usage: "help({ tool: 'mcp_ssh_manager' }) или help({ tool: 'mcp_ssh_manager', action: 'exec' })",
            legend: {
                hint: "Вся семантика общих полей и правил resolution — в `legend()` (или `help({ tool: 'legend' })`).",
                includes: ['common_fields', 'resolution', 'refs', 'safety', 'golden_path'],
            },
            tools: Object.entries(visibleSummaries).map(([key, value]) => ({
                name: key,
                description: value.description,
                usage: value.usage,
                actions: extractActions(key),
            })),
        };
    }
    ensureInitialized() {
        if (!this.initialized) {
            throw new Error('SentryFrogg MCP Server not initialized');
        }
    }
    handleLegend(args = {}) {
        this.ensureInitialized();
        return this.buildLegendPayload();
    }
    async run() {
        await this.initialize();
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        const cleanup = async () => {
            try {
                await ServiceBootstrap.cleanup();
                process.exit(0);
            }
            catch (error) {
                process.stderr.write(`Cleanup failed: ${error.message}\n`);
                process.exit(1);
            }
        };
        process.on('SIGINT', cleanup);
        process.on('SIGTERM', cleanup);
        process.on('uncaughtException', (error) => {
            process.stderr.write(`Uncaught exception: ${error.message}\n`);
            cleanup();
        });
    }
    getStats() {
        if (!this.initialized) {
            return { error: 'Server not initialized' };
        }
        return {
            version: '7.0.1',
            architecture: 'lightweight-service-layer',
            ...ServiceBootstrap.getStats(),
        };
    }
}
if (require.main === module) {
    const server = new SentryFroggServer();
    server.run().catch((error) => {
        process.stderr.write(`Server run failed: ${error.message}\n`);
        process.exit(1);
    });
}
module.exports = SentryFroggServer;
