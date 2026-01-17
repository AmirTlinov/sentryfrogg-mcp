#!/usr/bin/env node
// @ts-nocheck

/**
 * ✨ Arg aliases / normalization helpers.
 *
 * Goal: accept common "near-miss" parameter names without sacrificing safety.
 * - No silent overwrite: canonical key wins; alias is ignored and recorded.
 * - No value leaks: normalization report contains only key mapping metadata.
 */

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function hasOwn(obj, key) {
  return Boolean(obj && Object.prototype.hasOwnProperty.call(obj, key));
}

function isFiniteNumber(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (typeof value === 'string' && value.trim().length) {
    const parsed = Number(value);
    return Number.isFinite(parsed);
  }
  return false;
}

function toNumber(value) {
  if (typeof value === 'number') {
    return value;
  }
  return Number(value);
}

function buildNormalizationState() {
  return {
    renamed: [],
    converted: [],
    ignored: [],
  };
}

function compactNormalization(state) {
  if (!state) {
    return null;
  }
  const hasAny = (Array.isArray(state.renamed) && state.renamed.length > 0)
    || (Array.isArray(state.converted) && state.converted.length > 0)
    || (Array.isArray(state.ignored) && state.ignored.length > 0);
  if (!hasAny) {
    return null;
  }
  const out = {};
  if (state.renamed?.length) {
    out.renamed = state.renamed;
  }
  if (state.converted?.length) {
    out.converted = state.converted;
  }
  if (state.ignored?.length) {
    out.ignored = state.ignored;
  }
  return out;
}

function renameKey(out, fromKey, toKey, state, { allowedKeys, note } = {}) {
  if (!hasOwn(out, fromKey)) {
    return;
  }
  if (allowedKeys && !allowedKeys.has(toKey)) {
    return;
  }

  if (hasOwn(out, toKey)) {
    delete out[fromKey];
    state.ignored.push({
      from: fromKey,
      to: toKey,
      reason: 'canonical_already_set',
      note,
    });
    return;
  }

  out[toKey] = out[fromKey];
  delete out[fromKey];
  state.renamed.push({
    from: fromKey,
    to: toKey,
    note,
  });
}

function convertSecondsToMs(out, fromKey, toKey, state, { allowedKeys, note } = {}) {
  if (!hasOwn(out, fromKey)) {
    return;
  }
  if (allowedKeys && !allowedKeys.has(toKey)) {
    return;
  }

  if (hasOwn(out, toKey)) {
    delete out[fromKey];
    state.ignored.push({
      from: fromKey,
      to: toKey,
      reason: 'canonical_already_set',
      note,
    });
    return;
  }

  const raw = out[fromKey];
  if (isFiniteNumber(raw)) {
    out[toKey] = Math.floor(toNumber(raw) * 1000);
  } else {
    // Keep value (will likely fail schema validation), but ensure unknown key is removed.
    out[toKey] = raw;
  }
  delete out[fromKey];
  state.converted.push({
    from: fromKey,
    to: toKey,
    op: 'seconds_to_ms',
    factor: 1000,
    note,
  });
}

function normalizeArgsAliases(args, { tool, action, allowedKeys } = {}) {
  if (!isPlainObject(args)) {
    return { args, normalization: null };
  }

  const out = { ...args };
  const state = buildNormalizationState();
  const safeTool = typeof tool === 'string' ? tool : '';
  const safeAction = typeof action === 'string' ? action : '';

  // Global high-frequency aliases (safe, obvious).
  renameKey(out, 'cmd', 'command', state, { allowedKeys });
  renameKey(out, 'argv', 'args', state, { allowedKeys });
  renameKey(out, 'workdir', 'cwd', state, { allowedKeys });
  renameKey(out, 'work_dir', 'cwd', state, { allowedKeys });

  renameKey(out, 'timeout', 'timeout_ms', state, { allowedKeys });
  renameKey(out, 'timeoutMs', 'timeout_ms', state, { allowedKeys });
  convertSecondsToMs(out, 'timeout_s', 'timeout_ms', state, { allowedKeys });

  renameKey(out, 'profile', 'profile_name', state, { allowedKeys });
  renameKey(out, 'profileName', 'profile_name', state, { allowedKeys });

  // Action-scoped aliases (avoid collisions with tools that legitimately use `name`).
  if (safeAction.startsWith('profile_')) {
    renameKey(out, 'name', 'profile_name', state, { allowedKeys, note: 'profile_* sugar' });
  }

  // Tool-specific aliases.
  if (safeTool === 'help') {
    renameKey(out, 'q', 'query', state, { allowedKeys });
  }

  if (safeTool === 'mcp_api_client') {
    renameKey(out, 'params', 'query', state, { allowedKeys });
  }

  if (safeTool === 'mcp_psql_manager' && safeAction === 'query') {
    renameKey(out, 'query', 'sql', state, { allowedKeys, note: 'query action expects sql' });
  }

  if (safeTool === 'mcp_jobs') {
    renameKey(out, 'poll_interval', 'poll_interval_ms', state, { allowedKeys });
    convertSecondsToMs(out, 'poll_interval_s', 'poll_interval_ms', state, { allowedKeys });
  }

  if (safeTool === 'mcp_pipeline') {
    convertSecondsToMs(out, 'settle_s', 'settle_ms', state, { allowedKeys });
    convertSecondsToMs(out, 'smoke_delay_s', 'smoke_delay_ms', state, { allowedKeys });
    convertSecondsToMs(out, 'smoke_timeout_s', 'smoke_timeout_ms', state, { allowedKeys });
  }

  if (safeTool === 'mcp_ssh_manager') {
    renameKey(out, 'start_timeout', 'start_timeout_ms', state, { allowedKeys });
    convertSecondsToMs(out, 'start_timeout_s', 'start_timeout_ms', state, { allowedKeys });
  }

  return { args: out, normalization: compactNormalization(state) };
}

module.exports = {
  normalizeArgsAliases,
};

