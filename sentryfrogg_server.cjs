#!/usr/bin/env node

// SentryFrogg MCP Server v6.4.0

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
const {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} = require('@modelcontextprotocol/sdk/types.js');
const crypto = require('crypto');
const fsSync = require('fs');
const fs = require('fs/promises');
const path = require('path');

const ServiceBootstrap = require('./src/bootstrap/ServiceBootstrap.cjs');
const { isUnsafeLocalEnabled } = require('./src/utils/featureFlags.cjs');
const { redactObject } = require('./src/utils/redact.cjs');

const HELP_TOOL_ALIASES = {
  sql: 'mcp_psql_manager',
  psql: 'mcp_psql_manager',
  ssh: 'mcp_ssh_manager',
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
      additionalProperties: true,
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
      additionalProperties: true,
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
        target: { type: 'string' },
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
      additionalProperties: true,
    },
  },
  {
    name: 'mcp_workspace',
    description: 'Unified workspace UX: summary, suggestions, diagnostics, and legacy store migration.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['summary', 'suggest', 'diagnose', 'store_status', 'migrate_legacy', 'run', 'cleanup', 'stats'] },
        key: { type: 'string' },
        project: { type: 'string' },
        target: { type: 'string' },
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
      additionalProperties: true,
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
        target: { type: 'string' },
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
      additionalProperties: true,
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
      additionalProperties: true,
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
      additionalProperties: true,
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
        target: { type: 'string' },
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
      additionalProperties: true,
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
        target: { type: 'string' },
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
      additionalProperties: true,
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
      additionalProperties: true,
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
      additionalProperties: true,
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
      additionalProperties: true,
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
      additionalProperties: true,
    },
  },
  {
    name: 'mcp_pipeline',
    description: 'Streaming pipelines between HTTP, SFTP, and PostgreSQL.',
	    inputSchema: {
	      type: 'object',
	      properties: {
	        action: { type: 'string', enum: ['run', 'describe'] },
	        flow: { type: 'string', enum: ['http_to_sftp', 'sftp_to_http', 'http_to_postgres', 'sftp_to_postgres', 'postgres_to_sftp', 'postgres_to_http'] },
	        project: { type: 'string' },
	        target: { type: 'string' },
	        vault_profile_name: { type: 'string' },
	        vault_profile: { type: 'string' },
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
      additionalProperties: true,
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
        target: { type: 'string' },
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
      additionalProperties: true,
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
	        target: { type: 'string' },
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
      additionalProperties: true
    }
  },
  {
    name: 'mcp_ssh_manager',
    description: 'SSH executor with profiles, exec/batch diagnostics, and SFTP helpers.',
	    inputSchema: {
	      type: 'object',
	      properties: {
	        action: { type: 'string', enum: ['profile_upsert', 'profile_get', 'profile_list', 'profile_delete', 'profile_test', 'authorized_keys_add', 'exec', 'exec_detached', 'batch', 'system_info', 'check_host', 'sftp_list', 'sftp_upload', 'sftp_download'] },
	        profile_name: { type: 'string' },
	        include_secrets: { type: 'boolean' },
	        connection: { type: 'object' },
	        project: { type: 'string' },
	        target: { type: 'string' },
	        vault_profile_name: { type: 'string' },
	        vault_profile: { type: 'string' },
	        host_key_policy: { type: 'string', enum: ['accept', 'tofu', 'pin'] },
	        host_key_fingerprint_sha256: { type: 'string' },
	        public_key: { type: 'string' },
	        public_key_path: { type: 'string' },
	        authorized_keys_path: { type: 'string' },
	        command: { type: 'string' },
        cwd: { type: 'string' },
        env: { type: 'object' },
	        stdin: { type: 'string' },
	        log_path: { type: 'string' },
	        pid_path: { type: 'string' },
        timeout_ms: { type: 'integer' },
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
      additionalProperties: true
    }
  },
  {
    name: 'mcp_api_client',
    description: 'HTTP client with profiles, auth providers, retry/backoff, pagination, and downloads.',
	    inputSchema: {
	      type: 'object',
	      properties: {
	        action: { type: 'string', enum: ['profile_upsert', 'profile_get', 'profile_list', 'profile_delete', 'request', 'paginate', 'download', 'check'] },
	        profile_name: { type: 'string' },
	        include_secrets: { type: 'boolean' },
	        project: { type: 'string' },
	        target: { type: 'string' },
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
      additionalProperties: true
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
      additionalProperties: true,
    },
  });
}

const toolByName = Object.fromEntries(toolCatalog.map((tool) => [tool.name, tool]));
toolCatalog.push(
  { name: 'sql', description: 'Alias for mcp_psql_manager.', inputSchema: toolByName.mcp_psql_manager.inputSchema },
  { name: 'psql', description: 'Alias for mcp_psql_manager.', inputSchema: toolByName.mcp_psql_manager.inputSchema },
  { name: 'ssh', description: 'Alias for mcp_ssh_manager.', inputSchema: toolByName.mcp_ssh_manager.inputSchema },
  { name: 'http', description: 'Alias for mcp_api_client.', inputSchema: toolByName.mcp_api_client.inputSchema },
  { name: 'api', description: 'Alias for mcp_api_client.', inputSchema: toolByName.mcp_api_client.inputSchema },
  { name: 'repo', description: 'Alias for mcp_repo.', inputSchema: toolByName.mcp_repo.inputSchema },
  { name: 'state', description: 'Alias for mcp_state.', inputSchema: toolByName.mcp_state.inputSchema },
  { name: 'project', description: 'Alias for mcp_project.', inputSchema: toolByName.mcp_project.inputSchema },
  { name: 'context', description: 'Alias for mcp_context.', inputSchema: toolByName.mcp_context.inputSchema },
  { name: 'workspace', description: 'Alias for mcp_workspace.', inputSchema: toolByName.mcp_workspace.inputSchema },
  { name: 'env', description: 'Alias for mcp_env.', inputSchema: toolByName.mcp_env.inputSchema },
  { name: 'vault', description: 'Alias for mcp_vault.', inputSchema: toolByName.mcp_vault.inputSchema },
  { name: 'runbook', description: 'Alias for mcp_runbook.', inputSchema: toolByName.mcp_runbook.inputSchema },
  { name: 'capability', description: 'Alias for mcp_capability.', inputSchema: toolByName.mcp_capability.inputSchema },
  { name: 'intent', description: 'Alias for mcp_intent.', inputSchema: toolByName.mcp_intent.inputSchema },
  { name: 'evidence', description: 'Alias for mcp_evidence.', inputSchema: toolByName.mcp_evidence.inputSchema },
  { name: 'alias', description: 'Alias for mcp_alias.', inputSchema: toolByName.mcp_alias.inputSchema },
  { name: 'preset', description: 'Alias for mcp_preset.', inputSchema: toolByName.mcp_preset.inputSchema },
  { name: 'audit', description: 'Alias for mcp_audit.', inputSchema: toolByName.mcp_audit.inputSchema },
  { name: 'pipeline', description: 'Alias for mcp_pipeline.', inputSchema: toolByName.mcp_pipeline.inputSchema }
);

if (toolByName.mcp_local) {
  toolCatalog.push({ name: 'local', description: 'Alias for mcp_local.', inputSchema: toolByName.mcp_local.inputSchema });
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
    out.properties = Object.fromEntries(
      Object.entries(out.properties).map(([key, value]) => [key, normalizeJsonSchemaForOpenAI(value)])
    );
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
  } catch (error) {
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

function formatHelpResultToContext(result) {
  const lines = buildContextHeaderLegend();
  lines.push('[DATA]');

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
  lines.push('[DATA]');
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
  const lines = ['[DATA]'];

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
    this.server = new Server(
      {
        name: 'sentryfrogg',
        version: '6.4.0',
      },
      {
        capabilities: {
          tools: { list: true, call: true },
        },
        protocolVersion: '2025-06-18',
      }
    );
    this.container = null;
    this.initialized = false;
  }

  async initialize() {
    try {
      this.container = await ServiceBootstrap.initialize();
      await this.setupHandlers();
      this.initialized = true;
      const logger = this.container.get('logger');
      logger.info('SentryFrogg MCP Server v6.4.0 ready');
    } catch (error) {
      process.stderr.write(`Failed to initialize SentryFrogg MCP Server: ${error.message}\n`);
      throw error;
    }
  }

  async setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolCatalog.map(normalizeToolForOpenAI) }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const toolExecutor = this.container.get('toolExecutor');

      try {
        let result;
        let payload;
        const startedAt = Date.now();
        switch (name) {
          case 'help': {
            const traceId = args?.trace_id || crypto.randomUUID();
            const spanId = args?.span_id || crypto.randomUUID();
            const parentSpanId = args?.parent_span_id;
            result = this.handleHelp(args);
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
        const artifact = contextRoot
          ? buildArtifactRef({ traceId: meta?.trace_id, spanId: meta?.span_id })
          : null;

        let artifactWriteError;
        let artifactPath;
        let text;

        const toolName = meta?.tool || name;
        const actionName = meta?.action || args?.action;

        if (toolName === 'help') {
          if (
            toolResult &&
            typeof toolResult === 'object' &&
            toolResult.name === 'legend' &&
            toolResult.common_fields &&
            toolResult.resolution
          ) {
            text = formatLegendResultToContext(toolResult);
          } else {
            text = formatHelpResultToContext(toolResult);
          }
        } else if (toolName === 'legend') {
          text = formatLegendResultToContext(toolResult);
        } else {
          text = formatGenericResultToContext({
            tool: toolName,
            action: actionName,
            result: toolResult,
            meta,
            artifactUri: artifact?.uri,
          });
        }

        if (artifact && contextRoot) {
          try {
            artifactPath = await writeContextArtifact(contextRoot, artifact, text);
          } catch (error) {
            artifactWriteError = error?.message || String(error);
          }

          if (artifactWriteError) {
            if (toolName === 'help') {
              text = `${text}N: artifact_write_failed: ${artifactWriteError}\n`;
            } else if (toolName === 'legend') {
              text = `${text}N: artifact_write_failed: ${artifactWriteError}\n`;
            } else {
              text = formatGenericResultToContext({
                tool: toolName,
                action: actionName,
                result: toolResult,
                meta,
                artifactUri: artifact.uri,
                artifactWriteError,
              });
            }
          }

          if (artifactPath) {
            if (!text.includes(`R: ${artifact.uri}`)) {
              text = text.replace('[DATA]\n', `[DATA]\nR: ${artifact.uri}\n`);
            }
            if (!text.includes(`N: artifact_path:`)) {
              text = `${text}N: artifact_path: ${artifactPath}\n`;
            }
          }
        }

        return {
          content: [
            {
              type: 'text',
              text,
            },
          ],
        };
      } catch (error) {
        const logger = this.container?.get('logger');
        logger?.error('Tool execution failed', {
          tool: name,
          action: args?.action,
          error: error.message,
        });

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
    const aliases = Object.fromEntries(
      Object.entries(HELP_TOOL_ALIASES).filter(([, toolName]) => Boolean(toolByName[toolName]))
    );

    return {
      name: 'legend',
      description: 'Каноничная семантика SentryFrogg MCP: общие поля, порядок разрешения и безопасные дефолты.',
      mental_model: [
        'Думайте о SentryFrogg как о «наборе адаптеров + память»: вы вызываете tool+action и получаете результат (который можно дополнительно сформировать через `output` и/или сохранить через `store_as`).',
        "Основная UX-ось: один раз связать `project`+`target` с профилями → дальше вызывать `ssh`/`env`/`psql`/`api` только с `target`.",
      ],
      response: {
        shape: 'Инструменты возвращают «сам результат» (после применения `output`). Ошибки возвращаются как MCP error.',
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

  handleHelp(args = {}) {
    this.ensureInitialized();
    const rawTool = args.tool ? String(args.tool).trim().toLowerCase() : '';
    const rawAction = args.action ? String(args.action).trim() : '';

    const tool = rawTool ? (HELP_TOOL_ALIASES[rawTool] || rawTool) : '';
    const action = rawAction || '';

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
      ]);
      return Object.keys(props).filter((key) => !ignored.has(key));
    };

    const buildExample = (toolName, actionName) => {
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
          case 'exec_detached':
            return {
              action: 'exec_detached',
              target: 'prod',
              command: 'sleep 60 && echo done',
              log_path: '/tmp/sentryfrogg-detached.log',
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
            return { action: 'apply_patch', repo_root: '/repo', apply: true, patch: 'diff --git a/file b/file\n...' };
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
        usage: "profile_upsert/profile_list → (optional) authorized_keys_add → exec/exec_detached/batch/system_info/check_host/sftp_*",
      },
      mcp_api_client: {
        description: 'HTTP: профили, request/paginate/download, retry/backoff, auth providers + cache.',
        usage: "profile_upsert/profile_list → request/paginate/download/check",
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
        description: 'Projects: привязка SSH/env профилей к проектам и выбор активного проекта.',
        usage: 'project_upsert/project_list → project_use → (ssh/env без явного profile_name)',
      },
      mcp_context: {
        description: 'Context: обнаружение сигналов проекта и сводка контекста.',
        usage: 'summary/get → refresh → list/stats',
      },
      mcp_workspace: {
        description: 'Workspace: сводка, подсказки, диагностика и перенос legacy-хранилища.',
        usage: 'summary/suggest → run → cleanup → diagnose → store_status/migrate_legacy',
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
        usage: 'run/describe',
      },
    };

    if (isUnsafeLocalEnabled()) {
      summaries.mcp_local = {
        description: 'Local (UNSAFE): локальные exec и filesystem операции (только при включённом unsafe режиме).',
        usage: 'exec/batch/fs_read/fs_write/fs_list/fs_stat/fs_mkdir/fs_rm',
      };
    }

    if (tool) {
      if (tool === 'legend') {
        return this.buildLegendPayload();
      }

      if (!summaries[tool]) {
        return {
          error: `Неизвестный инструмент: ${tool}`,
          known_tools: Object.keys(summaries).sort(),
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
          return {
            ...entry,
            error: `Неизвестный action для ${tool}: ${action}`,
            known_actions: actions,
          };
        }
        return {
          ...entry,
          action,
          example: buildExample(tool, action),
        };
      }

      return {
        ...entry,
        legend_hint: "См. `legend()` для семантики общих полей (`output`, `store_as`, `preset`, `project/target`).",
      };
    }

    return {
      overview: isUnsafeLocalEnabled()
        ? 'SentryFrogg MCP подключает PostgreSQL, SSH, HTTP, state, project, context, runbook, capability/intent/evidence, alias, preset, audit, pipeline и (unsafe) local инструменты.'
        : 'SentryFrogg MCP подключает PostgreSQL, SSH, HTTP, state, project, context, runbook, capability/intent/evidence, alias, preset, audit и pipeline инструменты.',
      usage: "help({ tool: 'mcp_ssh_manager' }) или help({ tool: 'mcp_ssh_manager', action: 'exec' })",
      legend: {
        hint: "Вся семантика общих полей и правил resolution — в `legend()` (или `help({ tool: 'legend' })`).",
        includes: ['common_fields', 'resolution', 'refs', 'safety', 'golden_path'],
      },
      tools: Object.entries(summaries).map(([key, value]) => ({
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
      } catch (error) {
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
      version: '6.4.0',
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
