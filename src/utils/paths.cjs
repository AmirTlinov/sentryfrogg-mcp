#!/usr/bin/env node

const path = require('path');

function resolveProfileBaseDir() {
  if (process.env.MCP_PROFILES_DIR) {
    return path.resolve(process.env.MCP_PROFILES_DIR);
  }

  const candidate = require.main?.filename || process.argv[1];
  if (candidate) {
    return path.dirname(candidate);
  }

  return process.cwd();
}

function resolveProfileKeyPath() {
  if (process.env.MCP_PROFILE_KEY_PATH) {
    return path.resolve(process.env.MCP_PROFILE_KEY_PATH);
  }

  return path.join(resolveProfileBaseDir(), '.mcp_profiles.key');
}

module.exports = {
  resolveProfileBaseDir,
  resolveProfileKeyPath,
  resolveStatePath() {
    if (process.env.MCP_STATE_PATH) {
      return path.resolve(process.env.MCP_STATE_PATH);
    }
    return path.join(resolveProfileBaseDir(), 'state.json');
  },
  resolveRunbooksPath() {
    if (process.env.MCP_RUNBOOKS_PATH) {
      return path.resolve(process.env.MCP_RUNBOOKS_PATH);
    }
    return path.join(resolveProfileBaseDir(), 'runbooks.json');
  },
  resolveAliasesPath() {
    if (process.env.MCP_ALIASES_PATH) {
      return path.resolve(process.env.MCP_ALIASES_PATH);
    }
    return path.join(resolveProfileBaseDir(), 'aliases.json');
  },
  resolvePresetsPath() {
    if (process.env.MCP_PRESETS_PATH) {
      return path.resolve(process.env.MCP_PRESETS_PATH);
    }
    return path.join(resolveProfileBaseDir(), 'presets.json');
  },
  resolveAuditPath() {
    if (process.env.MCP_AUDIT_PATH) {
      return path.resolve(process.env.MCP_AUDIT_PATH);
    }
    return path.join(resolveProfileBaseDir(), 'audit.jsonl');
  },
  resolveCacheDir() {
    if (process.env.MCP_CACHE_DIR) {
      return path.resolve(process.env.MCP_CACHE_DIR);
    }
    return path.join(resolveProfileBaseDir(), 'cache');
  },
};
