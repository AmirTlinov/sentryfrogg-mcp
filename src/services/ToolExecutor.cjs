#!/usr/bin/env node

/**
 * 🧰 Tool execution wrapper: output shaping, state capture, trace metadata.
 */

const crypto = require('crypto');
const { applyOutputTransform } = require('../utils/output.cjs');
const { mergeDeep } = require('../utils/merge.cjs');
const { redactObject } = require('../utils/redact.cjs');

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

    if (store?.key) {
      await this.stateService.set(store.key, shaped, store.scope);
    }

    return {
      ok: true,
      result: shaped,
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
