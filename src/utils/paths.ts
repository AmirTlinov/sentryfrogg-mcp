#!/usr/bin/env node
// @ts-nocheck

const fs = require('fs');
const os = require('os');
const path = require('path');

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

function resolveEntryDir() {
  const entryCandidate = process.argv[1] || require.main?.filename;
  if (!entryCandidate) {
    return null;
  }
  return path.dirname(entryCandidate);
}

function resolveProfileBaseDir() {
  if (process.env.MCP_PROFILES_DIR) {
    return path.resolve(process.env.MCP_PROFILES_DIR);
  }

  const xdgStateDir = resolveXdgStateDir();
  if (xdgStateDir) {
    return path.join(xdgStateDir, 'sentryfrogg');
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
  resolveStoreMode() {
    if (process.env.MCP_PROFILES_DIR) {
      return 'custom';
    }
    const xdgStateDir = resolveXdgStateDir();
    if (xdgStateDir) {
      return 'xdg';
    }
    return 'fallback';
  },
  resolveStoreInfo() {
    return {
      base_dir: resolveProfileBaseDir(),
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
    const entryDir = resolveEntryDir();
    const candidates = [];
    if (entryDir) {
      candidates.push(path.join(entryDir, 'runbooks.json'));
      candidates.push(path.join(entryDir, '..', 'runbooks.json'));
    }
    candidates.push(path.join(__dirname, '..', '..', 'runbooks.json'));
    for (const candidate of candidates) {
      if (candidate && fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return candidates[0] || null;
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
    const entryDir = resolveEntryDir();
    const candidates = [];
    if (entryDir) {
      candidates.push(path.join(entryDir, 'capabilities.json'));
      candidates.push(path.join(entryDir, '..', 'capabilities.json'));
    }
    candidates.push(path.join(__dirname, '..', '..', 'capabilities.json'));
    for (const candidate of candidates) {
      if (candidate && fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return candidates[0] || null;
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
