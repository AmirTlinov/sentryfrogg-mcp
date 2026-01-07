#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');

const LEGACY_ENV_FLAG = 'MCP_LEGACY_STORE';

function resolveHomeDir() {
  try {
    const home = os.homedir();
    return home && typeof home === 'string' ? home : null;
  } catch (error) {
    return null;
  }
}

function resolveXdgStateDir() {
  if (process.env.XDG_STATE_HOME) {
    return path.resolve(process.env.XDG_STATE_HOME);
  }

  const home = resolveHomeDir();
  if (home) {
    return path.join(home, '.local', 'state');
  }

  return null;
}

function hasLegacyStore(dirPath) {
  if (!dirPath || typeof dirPath !== 'string') {
    return false;
  }

  const candidates = [
    '.mcp_profiles.key',
    'profiles.json',
    'state.json',
    'projects.json',
    'runbooks.json',
    'context.json',
    'aliases.json',
    'presets.json',
    'audit.jsonl',
    'cache',
  ];

  return candidates.some((name) => fs.existsSync(path.join(dirPath, name)));
}

function resolveEntryDir() {
  const entryCandidate = process.argv[1] || require.main?.filename;
  if (!entryCandidate) {
    return null;
  }
  return path.dirname(entryCandidate);
}

function resolveLegacyBaseDir() {
  const entryDir = resolveEntryDir();
  if (entryDir && hasLegacyStore(entryDir)) {
    return entryDir;
  }
  return null;
}

function isLegacyMode() {
  const flag = String(process.env[LEGACY_ENV_FLAG] || '').trim().toLowerCase();
  return flag === '1' || flag === 'true' || flag === 'yes';
}

function resolveProfileBaseDir() {
  if (process.env.MCP_PROFILES_DIR) {
    return path.resolve(process.env.MCP_PROFILES_DIR);
  }

  if (isLegacyMode()) {
    const legacyDir = resolveLegacyBaseDir();
    if (legacyDir) {
      return legacyDir;
    }
  }

  const xdgStateDir = resolveXdgStateDir();
  if (xdgStateDir) {
    return path.join(xdgStateDir, 'sentryfrogg');
  }

  const legacyDir = resolveLegacyBaseDir();
  if (legacyDir) {
    return legacyDir;
  }

  const entryDir = resolveEntryDir();
  return entryDir || process.cwd();
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
  resolveEntryDir,
  resolveLegacyBaseDir,
  isLegacyMode,
  resolveStoreMode() {
    if (process.env.MCP_PROFILES_DIR) {
      return 'custom';
    }
    if (isLegacyMode() && resolveLegacyBaseDir()) {
      return 'legacy';
    }
    const xdgStateDir = resolveXdgStateDir();
    if (xdgStateDir) {
      return 'xdg';
    }
    return resolveLegacyBaseDir() ? 'legacy' : 'fallback';
  },
  resolveStoreInfo() {
    return {
      base_dir: resolveProfileBaseDir(),
      legacy_dir: resolveLegacyBaseDir(),
      entry_dir: resolveEntryDir(),
      mode: module.exports.resolveStoreMode(),
    };
  },
  resolveProfilesPath() {
    if (process.env.MCP_PROFILES_PATH) {
      return path.resolve(process.env.MCP_PROFILES_PATH);
    }
    return path.join(resolveProfileBaseDir(), 'profiles.json');
  },
  resolveStatePath() {
    if (process.env.MCP_STATE_PATH) {
      return path.resolve(process.env.MCP_STATE_PATH);
    }
    return path.join(resolveProfileBaseDir(), 'state.json');
  },
  resolveProjectsPath() {
    if (process.env.MCP_PROJECTS_PATH) {
      return path.resolve(process.env.MCP_PROJECTS_PATH);
    }
    return path.join(resolveProfileBaseDir(), 'projects.json');
  },
  resolveRunbooksPath() {
    if (process.env.MCP_RUNBOOKS_PATH) {
      return path.resolve(process.env.MCP_RUNBOOKS_PATH);
    }
    return path.join(resolveProfileBaseDir(), 'runbooks.json');
  },
  resolveDefaultRunbooksPath() {
    if (process.env.MCP_DEFAULT_RUNBOOKS_PATH) {
      return path.resolve(process.env.MCP_DEFAULT_RUNBOOKS_PATH);
    }
    return path.join(__dirname, '..', '..', 'runbooks.json');
  },
  resolveCapabilitiesPath() {
    if (process.env.MCP_CAPABILITIES_PATH) {
      return path.resolve(process.env.MCP_CAPABILITIES_PATH);
    }
    return path.join(resolveProfileBaseDir(), 'capabilities.json');
  },
  resolveDefaultCapabilitiesPath() {
    if (process.env.MCP_DEFAULT_CAPABILITIES_PATH) {
      return path.resolve(process.env.MCP_DEFAULT_CAPABILITIES_PATH);
    }
    return path.join(__dirname, '..', '..', 'capabilities.json');
  },
  resolveContextPath() {
    if (process.env.MCP_CONTEXT_PATH) {
      return path.resolve(process.env.MCP_CONTEXT_PATH);
    }
    return path.join(resolveProfileBaseDir(), 'context.json');
  },
  resolveEvidenceDir() {
    if (process.env.MCP_EVIDENCE_DIR) {
      return path.resolve(process.env.MCP_EVIDENCE_DIR);
    }
    return path.join(resolveProfileBaseDir(), '.sentryfrogg', 'evidence');
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
  resolveJobsPath() {
    if (process.env.MCP_JOBS_PATH) {
      return path.resolve(process.env.MCP_JOBS_PATH);
    }
    if (process.env.SENTRYFROGG_JOBS_PATH) {
      return path.resolve(process.env.SENTRYFROGG_JOBS_PATH);
    }
    if (process.env.SF_JOBS_PATH) {
      return path.resolve(process.env.SF_JOBS_PATH);
    }
    return path.join(resolveProfileBaseDir(), 'jobs.json');
  },
  resolveCacheDir() {
    if (process.env.MCP_CACHE_DIR) {
      return path.resolve(process.env.MCP_CACHE_DIR);
    }
    return path.join(resolveProfileBaseDir(), 'cache');
  },
};
