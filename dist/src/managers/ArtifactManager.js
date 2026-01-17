#!/usr/bin/env node
"use strict";
// @ts-nocheck
Object.defineProperty(exports, "__esModule", { value: true });
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const ToolError = require('../errors/ToolError');
const { resolveContextRepoRoot, resolveArtifactPath } = require('../utils/artifacts');
const { isTruthy } = require('../utils/featureFlags');
const { redactText } = require('../utils/redact');
const { pathExists } = require('../utils/fsAtomic');
const { unknownActionError } = require('../utils/toolErrors');
const ARTIFACT_ACTIONS = ['get', 'head', 'tail', 'list'];
function allowSecretExport() {
    return isTruthy(process.env.SENTRYFROGG_ALLOW_SECRET_EXPORT) || isTruthy(process.env.SF_ALLOW_SECRET_EXPORT);
}
function seemsText(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        return true;
    }
    const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
    let nonPrintable = 0;
    for (const byte of sample) {
        if (byte === 0) {
            return false;
        }
        const isPrintableAscii = byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126);
        if (!isPrintableAscii) {
            nonPrintable += 1;
        }
    }
    return nonPrintable / sample.length < 0.3;
}
function ensureSecretExportAllowed(includeSecrets) {
    if (includeSecrets !== true) {
        return;
    }
    if (allowSecretExport()) {
        return;
    }
    throw ToolError.denied({
        code: 'SECRET_EXPORT_DISABLED',
        message: 'include_secrets=true is disabled for artifacts',
        hint: 'Set SENTRYFROGG_ALLOW_SECRET_EXPORT=1 (or SF_ALLOW_SECRET_EXPORT=1) to enable break-glass secret export.',
    });
}
function readPositiveInt(value) {
    if (value === undefined || value === null || value === '') {
        return null;
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) {
        return null;
    }
    return Math.floor(numeric);
}
function normalizeArtifactRel({ uri, rel }) {
    if (typeof uri === 'string' && uri.trim().length) {
        const trimmed = uri.trim();
        if (!trimmed.startsWith('artifact://')) {
            throw ToolError.invalidParams({ field: 'uri', message: 'uri must start with artifact://' });
        }
        const next = trimmed.slice('artifact://'.length);
        if (!next.trim().length) {
            throw ToolError.invalidParams({ field: 'uri', message: 'artifact uri must include path' });
        }
        return next;
    }
    if (typeof rel === 'string' && rel.trim().length) {
        return rel.trim();
    }
    throw ToolError.invalidParams({ message: 'Provide artifact uri or rel path', hint: "Example: { action: 'get', uri: 'artifact://runs/<trace>/tool_calls/<span>/stdout.log' }" });
}
function buildArtifactUri(rel) {
    const normalized = typeof rel === 'string' ? rel.trim() : '';
    return `artifact://${normalized}`;
}
async function readFileSlice(filePath, { offset, length }) {
    const handle = await fs.open(filePath, 'r');
    try {
        const stat = await handle.stat();
        const fileBytes = stat.size;
        const start = Math.max(0, Math.min(Number(offset) || 0, fileBytes));
        const maxLen = Math.max(0, Number(length) || 0);
        const toRead = Math.max(0, Math.min(maxLen, fileBytes - start));
        const buffer = Buffer.alloc(toRead);
        if (toRead > 0) {
            await handle.read(buffer, 0, toRead, start);
        }
        return {
            buffer,
            file_bytes: fileBytes,
            offset: start,
            length: toRead,
            truncated: start + toRead < fileBytes,
        };
    }
    finally {
        await handle.close();
    }
}
async function readTailSlice(filePath, { length }) {
    const handle = await fs.open(filePath, 'r');
    try {
        const stat = await handle.stat();
        const fileBytes = stat.size;
        const maxLen = Math.max(0, Number(length) || 0);
        const toRead = Math.max(0, Math.min(maxLen, fileBytes));
        const start = Math.max(0, fileBytes - toRead);
        const buffer = Buffer.alloc(toRead);
        if (toRead > 0) {
            await handle.read(buffer, 0, toRead, start);
        }
        return {
            buffer,
            file_bytes: fileBytes,
            offset: start,
            length: toRead,
            truncated: start > 0,
        };
    }
    finally {
        await handle.close();
    }
}
function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}
class ArtifactManager {
    constructor(logger, validation) {
        this.logger = logger.child('artifacts');
        this.validation = validation;
    }
    async handleAction(args = {}) {
        const action = args.action;
        switch (action) {
            case 'get':
                return this.get(args);
            case 'head':
                return this.head(args);
            case 'tail':
                return this.tail(args);
            case 'list':
                return this.list(args);
            default:
                throw unknownActionError({ tool: 'artifacts', action, knownActions: ARTIFACT_ACTIONS });
        }
    }
    resolveContextRoot() {
        const contextRoot = resolveContextRepoRoot();
        if (!contextRoot) {
            throw ToolError.denied({
                code: 'ARTIFACTS_UNAVAILABLE',
                message: 'Artifacts are unavailable (context repo root is not configured)',
                hint: 'Set SF_CONTEXT_REPO_ROOT (or SENTRYFROGG_CONTEXT_REPO_ROOT) to a writable directory.',
            });
        }
        return contextRoot;
    }
    async resolveFilePath({ uri, rel }) {
        const contextRoot = this.resolveContextRoot();
        const artifactRel = normalizeArtifactRel({ uri, rel });
        const filePath = resolveArtifactPath(contextRoot, artifactRel);
        const exists = await pathExists(filePath);
        if (!exists) {
            throw ToolError.notFound({
                code: 'ARTIFACT_NOT_FOUND',
                message: `Artifact not found: ${buildArtifactUri(artifactRel)}`,
                hint: 'Check the uri/rel or call { action: "list" } to discover available artifacts.',
                details: { uri: buildArtifactUri(artifactRel), rel: artifactRel },
            });
        }
        return { contextRoot, rel: artifactRel, uri: buildArtifactUri(artifactRel), filePath };
    }
    async get(args = {}) {
        const resolved = await this.resolveFilePath({ uri: args.uri, rel: args.rel });
        const includeSecrets = args.include_secrets === true;
        ensureSecretExportAllowed(includeSecrets);
        const maxBytes = Math.min(readPositiveInt(args.max_bytes) ?? 64 * 1024, 10 * 1024 * 1024);
        const offset = readPositiveInt(args.offset) ?? 0;
        const slice = await readFileSlice(resolved.filePath, { offset, length: maxBytes });
        const encoding = String(args.encoding || 'utf8').toLowerCase();
        const payload = {
            success: true,
            uri: resolved.uri,
            rel: resolved.rel,
            file_bytes: slice.file_bytes,
            offset: slice.offset,
            length: slice.length,
            truncated: slice.truncated,
            sha256: sha256(slice.buffer),
            encoding,
        };
        if (encoding === 'base64') {
            if (!includeSecrets && seemsText(slice.buffer)) {
                throw ToolError.denied({
                    code: 'ARTIFACT_BASE64_BLOCKED',
                    message: 'base64 artifact reads are blocked for text artifacts by default',
                    hint: "Use encoding='utf8' (redacted view), or set include_secrets=true (requires SENTRYFROGG_ALLOW_SECRET_EXPORT=1).",
                    details: { uri: resolved.uri, rel: resolved.rel, encoding },
                });
            }
            payload.content_base64 = slice.buffer.toString('base64');
        }
        else {
            const raw = slice.buffer.toString('utf8');
            if (includeSecrets) {
                payload.content = raw;
                payload.redacted = false;
            }
            else {
                const redacted = redactText(raw, { maxString: Number.POSITIVE_INFINITY });
                payload.content = redacted;
                payload.redacted = redacted !== raw;
            }
            payload.encoding = 'utf8';
        }
        return payload;
    }
    async head(args = {}) {
        const resolved = await this.resolveFilePath({ uri: args.uri, rel: args.rel });
        const includeSecrets = args.include_secrets === true;
        ensureSecretExportAllowed(includeSecrets);
        const maxBytes = Math.min(readPositiveInt(args.max_bytes) ?? 64 * 1024, 10 * 1024 * 1024);
        const slice = await readFileSlice(resolved.filePath, { offset: 0, length: maxBytes });
        const encoding = String(args.encoding || 'utf8').toLowerCase();
        const payload = {
            success: true,
            uri: resolved.uri,
            rel: resolved.rel,
            file_bytes: slice.file_bytes,
            offset: slice.offset,
            length: slice.length,
            truncated: slice.truncated,
            sha256: sha256(slice.buffer),
            encoding,
        };
        if (encoding === 'base64') {
            if (!includeSecrets && seemsText(slice.buffer)) {
                throw ToolError.denied({
                    code: 'ARTIFACT_BASE64_BLOCKED',
                    message: 'base64 artifact reads are blocked for text artifacts by default',
                    hint: "Use encoding='utf8' (redacted view), or set include_secrets=true (requires SENTRYFROGG_ALLOW_SECRET_EXPORT=1).",
                    details: { uri: resolved.uri, rel: resolved.rel, encoding },
                });
            }
            payload.content_base64 = slice.buffer.toString('base64');
        }
        else {
            const raw = slice.buffer.toString('utf8');
            if (includeSecrets) {
                payload.content = raw;
                payload.redacted = false;
            }
            else {
                const redacted = redactText(raw, { maxString: Number.POSITIVE_INFINITY });
                payload.content = redacted;
                payload.redacted = redacted !== raw;
            }
            payload.encoding = 'utf8';
        }
        return payload;
    }
    async tail(args = {}) {
        const resolved = await this.resolveFilePath({ uri: args.uri, rel: args.rel });
        const includeSecrets = args.include_secrets === true;
        ensureSecretExportAllowed(includeSecrets);
        const maxBytes = Math.min(readPositiveInt(args.max_bytes) ?? 64 * 1024, 10 * 1024 * 1024);
        const slice = await readTailSlice(resolved.filePath, { length: maxBytes });
        const encoding = String(args.encoding || 'utf8').toLowerCase();
        const payload = {
            success: true,
            uri: resolved.uri,
            rel: resolved.rel,
            file_bytes: slice.file_bytes,
            offset: slice.offset,
            length: slice.length,
            truncated: slice.truncated,
            sha256: sha256(slice.buffer),
            encoding,
        };
        if (encoding === 'base64') {
            if (!includeSecrets && seemsText(slice.buffer)) {
                throw ToolError.denied({
                    code: 'ARTIFACT_BASE64_BLOCKED',
                    message: 'base64 artifact reads are blocked for text artifacts by default',
                    hint: "Use encoding='utf8' (redacted view), or set include_secrets=true (requires SENTRYFROGG_ALLOW_SECRET_EXPORT=1).",
                    details: { uri: resolved.uri, rel: resolved.rel, encoding },
                });
            }
            payload.content_base64 = slice.buffer.toString('base64');
        }
        else {
            const raw = slice.buffer.toString('utf8');
            if (includeSecrets) {
                payload.content = raw;
                payload.redacted = false;
            }
            else {
                const redacted = redactText(raw, { maxString: Number.POSITIVE_INFINITY });
                payload.content = redacted;
                payload.redacted = redacted !== raw;
            }
            payload.encoding = 'utf8';
        }
        return payload;
    }
    async list(args = {}) {
        const contextRoot = this.resolveContextRoot();
        const prefix = typeof args.prefix === 'string' && args.prefix.trim().length ? args.prefix.trim() : '.';
        const limit = Math.min(readPositiveInt(args.limit) ?? 200, 2000);
        const baseDir = path.resolve(contextRoot, 'artifacts');
        const root = resolveArtifactPath(contextRoot, prefix);
        const exists = await pathExists(root);
        if (!exists) {
            return { success: true, prefix, items: [], count: 0 };
        }
        const items = [];
        const stack = [{ dir: root, rel: prefix === '.' ? '' : prefix }];
        while (stack.length && items.length < limit) {
            const current = stack.pop();
            if (!current) {
                continue;
            }
            let entries;
            try {
                entries = await fs.readdir(current.dir, { withFileTypes: true });
            }
            catch (error) {
                if (error.code === 'ENOTDIR') {
                    break;
                }
                throw error;
            }
            for (const entry of entries) {
                if (items.length >= limit) {
                    break;
                }
                const nextRel = current.rel ? `${current.rel}/${entry.name}` : entry.name;
                const entryPath = path.join(current.dir, entry.name);
                if (entry.isDirectory()) {
                    stack.push({ dir: entryPath, rel: nextRel });
                    continue;
                }
                const stat = await fs.stat(entryPath).catch(() => null);
                const fileBytes = stat?.size ?? null;
                items.push({
                    uri: buildArtifactUri(nextRel),
                    rel: nextRel,
                    bytes: fileBytes,
                    mtime: stat?.mtime ? stat.mtime.toISOString() : null,
                });
            }
        }
        return { success: true, prefix, items, count: items.length, truncated: items.length >= limit };
    }
}
module.exports = ArtifactManager;
