#!/usr/bin/env node

/**
 * 🧰 Tool execution wrapper: output shaping, state capture, trace metadata.
 */

const crypto = require('crypto');
const path = require('node:path');
const { applyOutputTransform } = require('../utils/output.cjs');
const { mergeDeep } = require('../utils/merge.cjs');
const { redactObject, isSensitiveKey } = require('../utils/redact.cjs');
const {
  resolveContextRepoRoot,
  buildToolCallFileRef,
  writeTextArtifact,
  writeBinaryArtifact,
} = require('../utils/artifacts.cjs');

const DEFAULT_MAX_INLINE_BYTES = 16 * 1024;
const DEFAULT_MAX_CAPTURE_BYTES = 256 * 1024;
const DEFAULT_MAX_SPILLS = 20;

function readPositiveInt(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue <= 0) {
    return null;
  }
  return Math.floor(numberValue);
}

function resolveMaxInlineBytes() {
  const raw = process.env.SENTRYFROGG_MAX_INLINE_BYTES || process.env.SF_MAX_INLINE_BYTES;
  return readPositiveInt(raw) ?? DEFAULT_MAX_INLINE_BYTES;
}

function resolveMaxCaptureBytes() {
  const raw = process.env.SENTRYFROGG_MAX_CAPTURE_BYTES || process.env.SF_MAX_CAPTURE_BYTES;
  return readPositiveInt(raw) ?? DEFAULT_MAX_CAPTURE_BYTES;
}

function safeFilenameSegment(value) {
  const base = String(value || '').trim() || 'value';
  return base
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+/, '')
    .replace(/_+$/, '')
    .slice(0, 64) || 'value';
}

function resolveSpillFilename(segments, { ext, used }) {
  const normalized = segments
    .filter((item) => item !== undefined && item !== null && String(item).trim().length)
    .slice(-6)
    .map((item) => safeFilenameSegment(item));

  const base = normalized.length ? normalized.join('__') : 'value';
  const safeBase = base.slice(0, 120);
  const candidateBase = `${safeBase}.${ext}`;
  const current = used.get(candidateBase) || 0;
  used.set(candidateBase, current + 1);
  if (current === 0) {
    return candidateBase;
  }
  const parsed = path.parse(candidateBase);
  return `${parsed.name}--${current + 1}${parsed.ext}`;
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
    } else {
      high = mid - 1;
    }
  }
  return value.slice(0, low);
}

function computeSha256Text(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function computeSha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function buildPreviewTailText(value, maxChars) {
  if (typeof value !== 'string') {
    return { preview: '', tail: '' };
  }
  const limit = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : 0;
  if (limit <= 0) {
    return { preview: '', tail: '' };
  }
  if (value.length <= limit * 2) {
    return { preview: value, tail: '' };
  }
  return {
    preview: value.slice(0, limit),
    tail: value.slice(-limit),
  };
}

async function spillLargeValues(value, options, pathSegments = [], state = null) {
  const ctx = options || {};
  const runState = state || {
    usedNames: new Map(),
    spilled: 0,
  };

  const maxInlineBytes = ctx.maxInlineBytes;
  const maxCaptureBytes = ctx.maxCaptureBytes;
  const maxSpills = ctx.maxSpills;
  const contextRoot = ctx.contextRoot;

  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    const bytes = Buffer.byteLength(value, 'utf8');
    if (bytes <= maxInlineBytes) {
      return value;
    }

    const hasSensitiveKey = pathSegments.some((segment) => isSensitiveKey(segment));
    const previewLimit = Math.min(2048, Math.max(128, Math.floor(maxInlineBytes / 4)));
    const { preview, tail } = buildPreviewTailText(value, previewLimit);

    const capped = truncateUtf8Prefix(value, maxCaptureBytes);
    const capturedBytes = Buffer.byteLength(capped, 'utf8');
    const sha256 = computeSha256Text(capped);
    const captureTruncated = capturedBytes < bytes;

    let artifact = null;
    if (!hasSensitiveKey && contextRoot && runState.spilled < maxSpills) {
      const filename = resolveSpillFilename(pathSegments, { ext: 'txt', used: runState.usedNames });
      const ref = buildToolCallFileRef({ traceId: ctx.traceId, spanId: ctx.spanId, filename });
      const written = await writeTextArtifact(contextRoot, ref, capped);
      runState.spilled += 1;
      artifact = { uri: written.uri, rel: written.rel, bytes: written.bytes, truncated: captureTruncated };
    }

    return {
      truncated: true,
      bytes,
      sha256,
      artifact,
      preview,
      tail,
    };
  }

  if (Buffer.isBuffer(value)) {
    const bytes = value.length;
    if (bytes <= maxInlineBytes) {
      return value;
    }

    const hasSensitiveKey = pathSegments.some((segment) => isSensitiveKey(segment));
    const captured = bytes > maxCaptureBytes ? value.subarray(0, maxCaptureBytes) : value;
    const sha256 = computeSha256Buffer(captured);
    const captureTruncated = captured.length < bytes;
    const previewLimit = Math.min(256, captured.length);
    const preview = captured.subarray(0, previewLimit).toString('base64');
    const tail = previewLimit < captured.length
      ? captured.subarray(captured.length - previewLimit).toString('base64')
      : '';

    let artifact = null;
    if (!hasSensitiveKey && contextRoot && runState.spilled < maxSpills) {
      const filename = resolveSpillFilename(pathSegments, { ext: 'bin', used: runState.usedNames });
      const ref = buildToolCallFileRef({ traceId: ctx.traceId, spanId: ctx.spanId, filename });
      const written = await writeBinaryArtifact(contextRoot, ref, captured);
      runState.spilled += 1;
      artifact = { uri: written.uri, rel: written.rel, bytes: written.bytes, truncated: captureTruncated };
    }

    return {
      truncated: true,
      bytes,
      sha256,
      artifact,
      preview,
      tail,
    };
  }

  if (typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    const next = await Promise.all(
      value.map((item, idx) => spillLargeValues(item, ctx, pathSegments.concat(String(idx)), runState))
    );
    return next;
  }

  const out = {};
  const entries = Object.entries(value);

  for (const [key, raw] of entries) {
    if (key.endsWith('_buffer') && Buffer.isBuffer(raw)) {
      const refKey = key.replace(/_buffer$/, '_ref');
      const existingRef = value[refKey];
      if (existingRef && typeof existingRef === 'object' && typeof existingRef.uri === 'string') {
        const bytes = raw.length;
        const captured = bytes > maxCaptureBytes ? raw.subarray(0, maxCaptureBytes) : raw;
        const sha256 = computeSha256Buffer(captured);
        const captureTruncated = captured.length < bytes;
        const previewLimit = Math.min(256, captured.length);
        const preview = captured.subarray(0, previewLimit).toString('base64');
        const tail = previewLimit < captured.length
          ? captured.subarray(captured.length - previewLimit).toString('base64')
          : '';

        out[key] = {
          truncated: true,
          bytes,
          sha256,
          artifact: { uri: existingRef.uri, rel: existingRef.rel, bytes: existingRef.bytes, truncated: existingRef.truncated ?? captureTruncated },
          preview,
          tail,
        };
        continue;
      }
    }

    out[key] = await spillLargeValues(raw, ctx, pathSegments.concat(key), runState);
  }

  return out;
}

class ToolExecutor {
  constructor(logger, stateService, aliasService, presetService, auditService, handlers = {}, options = {}) {
    this.logger = logger.child('executor');
    this.stateService = stateService;
    this.aliasService = aliasService;
    this.presetService = presetService;
    this.auditService = auditService;
    this.handlers = handlers;
    this.aliasMap = options.aliasMap || {};
  }

  register(tool, handler) {
    this.handlers[tool] = handler;
  }

  normalizeStoreTarget(storeAs, storeScope) {
    if (!storeAs) {
      return null;
    }
    if (typeof storeAs === 'string') {
      return { key: storeAs, scope: storeScope || 'session' };
    }
    if (typeof storeAs === 'object' && storeAs.key) {
      return { key: storeAs.key, scope: storeAs.scope ?? storeScope ?? 'session' };
    }
    return null;
  }

  async resolveAlias(tool) {
    if (this.handlers[tool]) {
      return { tool, alias: null };
    }

    if (this.aliasMap[tool]) {
      return { tool: this.aliasMap[tool], alias: { name: tool, tool: this.aliasMap[tool] } };
    }

    if (this.aliasService) {
      const entry = await this.aliasService.resolveAlias(tool);
      if (entry) {
        const mappedTool = this.handlers[entry.tool]
          ? entry.tool
          : (this.aliasMap[entry.tool] || entry.tool);
        return { tool: mappedTool, alias: { name: tool, ...entry, tool: mappedTool } };
      }
    }

    return { tool, alias: null };
  }

  normalizePresetData(preset) {
    if (!preset || typeof preset !== 'object') {
      return null;
    }

    if (preset.data && typeof preset.data === 'object' && !Array.isArray(preset.data)) {
      return preset.data;
    }

    const { created_at, updated_at, description, ...rest } = preset;
    return rest;
  }

  normalizeAliasArgs(alias) {
    if (!alias || typeof alias !== 'object') {
      return null;
    }

    if (alias.args && typeof alias.args === 'object' && !Array.isArray(alias.args)) {
      return alias.args;
    }

    return null;
  }

  mergeArgs(preset, aliasArgs, args) {
    let merged = preset ? mergeDeep({}, preset) : {};
    if (aliasArgs) {
      merged = mergeDeep(merged, aliasArgs);
    }
    if (args && typeof args === 'object') {
      merged = mergeDeep(merged, args);
    }
    return merged;
  }

  stripArgsForHandler(args) {
    const cleaned = { ...args };
    delete cleaned.output;
    delete cleaned.store_as;
    delete cleaned.store_scope;
    delete cleaned.preset;
    delete cleaned.preset_name;
    return cleaned;
  }

  buildAuditArgs(args) {
    const cleaned = this.stripArgsForHandler(args);
    if (cleaned.body_base64) {
      cleaned.body_base64 = `[base64:${String(cleaned.body_base64).length}]`;
    }
    if (cleaned.content_base64) {
      cleaned.content_base64 = `[base64:${String(cleaned.content_base64).length}]`;
    }
    if (Object.prototype.hasOwnProperty.call(cleaned, 'stdin')) {
      cleaned.stdin = cleaned.stdin === undefined || cleaned.stdin === null
        ? cleaned.stdin
        : `[stdin:${String(cleaned.stdin).length}]`;
    }
    if (Object.prototype.hasOwnProperty.call(cleaned, 'patch')) {
      cleaned.patch = cleaned.patch === undefined || cleaned.patch === null
        ? cleaned.patch
        : `[patch:${String(cleaned.patch).length}]`;
    }
    if (Object.prototype.hasOwnProperty.call(cleaned, 'content')) {
      if (typeof cleaned.content === 'string') {
        cleaned.content = `[content:${cleaned.content.length}]`;
      } else if (Buffer.isBuffer(cleaned.content)) {
        cleaned.content = `[buffer:${cleaned.content.length}]`;
      } else if (cleaned.content !== null && cleaned.content !== undefined) {
        cleaned.content = `[content:${typeof cleaned.content}]`;
      }
    }
    return redactObject(cleaned);
  }

  summarizeResult(result) {
    if (result === null || result === undefined) {
      return { type: String(result) };
    }
    if (typeof result === 'string') {
      return { type: 'string', length: result.length, preview: result.slice(0, 200) };
    }
    if (Buffer.isBuffer(result)) {
      return { type: 'buffer', length: result.length };
    }
    if (Array.isArray(result)) {
      return { type: 'array', length: result.length };
    }
    if (typeof result === 'object') {
      const keys = Object.keys(result);
      return { type: 'object', keys: keys.slice(0, 10), key_count: keys.length };
    }
    return { type: typeof result, value: result };
  }

  compactMeta(meta) {
    return Object.fromEntries(Object.entries(meta).filter(([, value]) => value !== undefined));
  }

  async wrapResult({ tool, args, result, startedAt, traceId, spanId, parentSpanId, invokedAs, presetName }) {
    const output = args.output;
    const store = this.normalizeStoreTarget(args.store_as, args.store_scope);

    const shaped = applyOutputTransform(result, output);
    const contextRoot = resolveContextRepoRoot();
    const maxInlineBytes = resolveMaxInlineBytes();
    const maxCaptureBytes = resolveMaxCaptureBytes();
    const maxSpills = readPositiveInt(process.env.SENTRYFROGG_MAX_SPILLS || process.env.SF_MAX_SPILLS) ?? DEFAULT_MAX_SPILLS;
    const spilled = await spillLargeValues(shaped, {
      contextRoot,
      traceId,
      spanId,
      maxInlineBytes,
      maxCaptureBytes,
      maxSpills,
    });

    if (store?.key) {
      await this.stateService.set(store.key, spilled, store.scope);
    }

    return {
      ok: true,
      result: spilled,
      meta: this.compactMeta({
        tool,
        action: args.action,
        trace_id: traceId,
        span_id: spanId,
        parent_span_id: parentSpanId,
        duration_ms: Date.now() - startedAt,
        stored_as: store?.key,
        invoked_as: invokedAs,
        preset: presetName,
      }),
    };
  }

  async execute(tool, args = {}) {
    const startedAt = Date.now();
    const resolved = await this.resolveAlias(tool);
    const handler = this.handlers[resolved.tool];
    if (!handler) {
      throw new Error(`Unknown tool: ${tool}`);
    }

    const traceId = args.trace_id || crypto.randomUUID();
    const parentSpanId = args.parent_span_id;
    const spanId = args.span_id || crypto.randomUUID();

    let presetName = args.preset || args.preset_name;
    if (!presetName && resolved.alias?.preset) {
      presetName = resolved.alias.preset;
    }

    let presetData = null;
    if (presetName && this.presetService) {
      presetData = this.normalizePresetData(
        await this.presetService.resolvePreset(resolved.tool, presetName)
      );
    }

    const mergedArgs = this.mergeArgs(presetData, this.normalizeAliasArgs(resolved.alias), args);
    mergedArgs.trace_id = traceId;
    mergedArgs.span_id = spanId;
    if (parentSpanId) {
      mergedArgs.parent_span_id = parentSpanId;
    }

    const cleanedArgs = this.stripArgsForHandler(mergedArgs);
    const invokedAs = resolved.alias ? tool : undefined;

    try {
      const result = await handler(cleanedArgs);
      const payload = await this.wrapResult({
        tool: resolved.tool,
        args: mergedArgs,
        result,
        startedAt,
        traceId,
        spanId,
        parentSpanId,
        invokedAs,
        presetName,
      });

      if (this.auditService) {
        await this.auditService.append({
          timestamp: new Date().toISOString(),
          status: 'ok',
          tool: resolved.tool,
          action: mergedArgs.action,
          trace_id: traceId,
          span_id: spanId,
          parent_span_id: parentSpanId,
          invoked_as: invokedAs,
          input: this.buildAuditArgs(mergedArgs),
          result_summary: this.summarizeResult(payload.result),
          duration_ms: Date.now() - startedAt,
        });
      }

      return payload;
    } catch (error) {
      if (this.auditService) {
        await this.auditService.append({
          timestamp: new Date().toISOString(),
          status: 'error',
          tool: resolved.tool,
          action: mergedArgs.action,
          trace_id: traceId,
          span_id: spanId,
          parent_span_id: parentSpanId,
          invoked_as: invokedAs,
          input: this.buildAuditArgs(mergedArgs),
          error: error.message,
          duration_ms: Date.now() - startedAt,
        });
      }

      throw error;
    }
  }
}

module.exports = ToolExecutor;
