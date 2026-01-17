#!/usr/bin/env node
// @ts-nocheck

const fs = require('fs');
const os = require('os');
const path = require('path');

function normalizeEnvPath(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const trimmed = String(value).trim();
  if (!trimmed) {
    return null;
  }
  const lowered = trimmed.toLowerCase();
  if (lowered === 'undefined' || lowered === 'null') {
    return null;
  }
  return trimmed;
}

function resolveHomeDir() {
  try {
    const home = os.homedir();
    return home && typeof home === 'string' ? home : null;
  } catch (error) {
    return null;
  }
}

function resolveXdgStateDir() {
  const xdgStateHome = normalizeEnvPath(process.env.XDG_STATE_HOME);
  if (xdgStateHome) {
    return path.resolve(xdgStateHome);
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
  const profilesDir = normalizeEnvPath(process.env.MCP_PROFILES_DIR);
  if (profilesDir) {
    return path.resolve(profilesDir);
  }

  const xdgStateDir = resolveXdgStateDir();
  if (xdgStateDir) {
    return path.join(xdgStateDir, 'sentryfrogg');
  }

  const entryDir = resolveEntryDir();
  return entryDir || process.cwd();
}

function resolveProfileKeyPath() {
  const profileKeyPath = normalizeEnvPath(process.env.MCP_PROFILE_KEY_PATH);
  if (profileKeyPath) {
    return path.resolve(profileKeyPath);
  }

  return path.join(resolveProfileBaseDir(), '.mcp_profiles.key');
}

module.exports = {
  resolveProfileBaseDir,
  resolveProfileKeyPath,
  resolveEntryDir,
  resolveStoreMode() {
    if (normalizeEnvPath(process.env.MCP_PROFILES_DIR)) {
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
    const profilesPath = normalizeEnvPath(process.env.MCP_PROFILES_PATH);
    if (profilesPath) {
      return path.resolve(profilesPath);
    }
    return path.join(resolveProfileBaseDir(), 'profiles.json');
  },
  resolveStatePath() {
    const statePath = normalizeEnvPath(process.env.MCP_STATE_PATH);
    if (statePath) {
      return path.resolve(statePath);
    }
    return path.join(resolveProfileBaseDir(), 'state.json');
  },
  resolveProjectsPath() {
    const projectsPath = normalizeEnvPath(process.env.MCP_PROJECTS_PATH);
    if (projectsPath) {
      return path.resolve(projectsPath);
    }
    return path.join(resolveProfileBaseDir(), 'projects.json');
  },
  resolveRunbooksPath() {
    const runbooksPath = normalizeEnvPath(process.env.MCP_RUNBOOKS_PATH);
    if (runbooksPath) {
      return path.resolve(runbooksPath);
    }
    return path.join(resolveProfileBaseDir(), 'runbooks.json');
  },
  resolveDefaultRunbooksPath() {
    const defaultRunbooksPath = normalizeEnvPath(process.env.MCP_DEFAULT_RUNBOOKS_PATH);
    if (defaultRunbooksPath) {
      return path.resolve(defaultRunbooksPath);
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
    const capabilitiesPath = normalizeEnvPath(process.env.MCP_CAPABILITIES_PATH);
    if (capabilitiesPath) {
      return path.resolve(capabilitiesPath);
    }
    return path.join(resolveProfileBaseDir(), 'capabilities.json');
  },
  resolveDefaultCapabilitiesPath() {
    const defaultCapabilitiesPath = normalizeEnvPath(process.env.MCP_DEFAULT_CAPABILITIES_PATH);
    if (defaultCapabilitiesPath) {
      return path.resolve(defaultCapabilitiesPath);
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
    const contextPath = normalizeEnvPath(process.env.MCP_CONTEXT_PATH);
    if (contextPath) {
      return path.resolve(contextPath);
    }
    return path.join(resolveProfileBaseDir(), 'context.json');
  },
  resolveEvidenceDir() {
    const evidenceDir = normalizeEnvPath(process.env.MCP_EVIDENCE_DIR);
    if (evidenceDir) {
      return path.resolve(evidenceDir);
    }
    return path.join(resolveProfileBaseDir(), '.sentryfrogg', 'evidence');
  },
  resolveAliasesPath() {
    const aliasesPath = normalizeEnvPath(process.env.MCP_ALIASES_PATH);
    if (aliasesPath) {
      return path.resolve(aliasesPath);
    }
    return path.join(resolveProfileBaseDir(), 'aliases.json');
  },
  resolvePresetsPath() {
    const presetsPath = normalizeEnvPath(process.env.MCP_PRESETS_PATH);
    if (presetsPath) {
      return path.resolve(presetsPath);
    }
    return path.join(resolveProfileBaseDir(), 'presets.json');
  },
  resolveAuditPath() {
    const auditPath = normalizeEnvPath(process.env.MCP_AUDIT_PATH);
    if (auditPath) {
      return path.resolve(auditPath);
    }
    return path.join(resolveProfileBaseDir(), 'audit.jsonl');
  },
  resolveJobsPath() {
    const jobsPath = normalizeEnvPath(process.env.MCP_JOBS_PATH);
    if (jobsPath) {
      return path.resolve(jobsPath);
    }
    const sfJobsPath = normalizeEnvPath(process.env.SENTRYFROGG_JOBS_PATH);
    if (sfJobsPath) {
      return path.resolve(sfJobsPath);
    }
    const shortJobsPath = normalizeEnvPath(process.env.SF_JOBS_PATH);
    if (shortJobsPath) {
      return path.resolve(shortJobsPath);
    }
    return path.join(resolveProfileBaseDir(), 'jobs.json');
  },
  resolveCacheDir() {
    const cacheDir = normalizeEnvPath(process.env.MCP_CACHE_DIR);
    if (cacheDir) {
      return path.resolve(cacheDir);
    }
    return path.join(resolveProfileBaseDir(), 'cache');
  },
};
