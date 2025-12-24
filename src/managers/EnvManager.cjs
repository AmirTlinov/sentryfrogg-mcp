#!/usr/bin/env node

/**
 * 🔐 Env manager: encrypted env bundles + safe apply to remote.
 */

const crypto = require('crypto');
const path = require('path');
const { isTruthy } = require('../utils/featureFlags.cjs');

const ENV_PROFILE_TYPE = 'env';

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeStringMap(input, label, { allowNull = true } = {}) {
  if (input === undefined) {
    return undefined;
  }
  if (input === null) {
    return null;
  }
  if (!isPlainObject(input)) {
    throw new Error(`${label} must be an object`);
  }

  const out = {};
  for (const [key, raw] of Object.entries(input)) {
    if (typeof key !== 'string' || key.trim().length === 0) {
      continue;
    }
    if (raw === undefined) {
      continue;
    }
    if (raw === null) {
      if (allowNull) {
        out[key] = null;
      }
      continue;
    }
    out[key] = String(raw);
  }
  return out;
}

function normalizeEnvKey(key) {
  const trimmed = String(key || '').trim();
  if (!trimmed) {
    throw new Error('env var key must be a non-empty string');
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
    throw new Error(`Invalid env var key: ${trimmed}`);
  }
  return trimmed;
}

function escapeEnvValue(value) {
  const str = String(value ?? '');
  const escaped = str
    .replace(/\\/g, '\\\\')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/"/g, '\\"');
  return `"${escaped}"`;
}

function renderDotenv(vars) {
  const entries = Object.entries(vars || {})
    .map(([k, v]) => [normalizeEnvKey(k), String(v ?? '')]);

  entries.sort(([a], [b]) => a.localeCompare(b));

const lines = entries.map(([key, value]) => `${key}=${escapeEnvValue(value)}`);
  return `${lines.join('\n')}\n`;
}

class EnvManager {
  constructor(logger, validation, profileService, sshManager, projectResolver) {
    this.logger = logger.child('env');
    this.validation = validation;
    this.profileService = profileService;
    this.sshManager = sshManager;
    this.projectResolver = projectResolver;
  }

  async handleAction(args = {}) {
    const { action } = args;

    switch (action) {
      case 'profile_upsert':
        return this.profileUpsert(args.profile_name, args);
      case 'profile_get':
        return this.profileGet(args.profile_name, args.include_secrets);
      case 'profile_list':
        return this.profileList();
      case 'profile_delete':
        return this.profileDelete(args.profile_name);
      case 'write_remote':
        return this.writeRemote(args);
      case 'run_remote':
        return this.runRemote(args);
      default:
        throw new Error(`Unknown env action: ${action}`);
    }
  }

  async resolveProfilesFromProject(args) {
    if (!this.projectResolver) {
      return {
        projectName: undefined,
        targetName: undefined,
        envProfile: undefined,
        sshProfile: undefined,
        cwd: undefined,
        envPath: undefined,
      };
    }

    const context = await this.projectResolver.resolveContext(args);
    if (!context) {
      return {
        projectName: undefined,
        targetName: undefined,
        envProfile: undefined,
        sshProfile: undefined,
        cwd: undefined,
        envPath: undefined,
      };
    }

    return {
      projectName: context.projectName,
      targetName: context.targetName,
      envProfile: context.target.env_profile,
      sshProfile: context.target.ssh_profile,
      cwd: context.target.cwd,
      envPath: context.target.env_path,
    };
  }

  async resolveEnvProfileName(args) {
    if (args.profile_name) {
      return this.validation.ensureString(args.profile_name, 'profile_name');
    }

    if (args.env_profile) {
      return this.validation.ensureString(String(args.env_profile), 'env_profile');
    }

    const resolved = await this.resolveProfilesFromProject(args);
    if (resolved.envProfile) {
      return this.validation.ensureString(String(resolved.envProfile), 'env_profile');
    }

    const profiles = await this.profileService.listProfiles(ENV_PROFILE_TYPE);
    if (profiles.length === 1) {
      return profiles[0].name;
    }
    if (profiles.length === 0) {
      throw new Error('env profile is required (no env profiles exist)');
    }
    throw new Error('env profile is required when multiple env profiles exist');
  }

  async resolveSshProfileName(args) {
    if (args.ssh_profile_name) {
      return this.validation.ensureString(String(args.ssh_profile_name), 'ssh_profile_name');
    }
    if (args.ssh_profile) {
      return this.validation.ensureString(String(args.ssh_profile), 'ssh_profile');
    }
    if (args.profile_name && args.action !== 'profile_upsert' && args.action !== 'profile_get' && args.action !== 'profile_delete') {
      // avoid collisions: profile_name belongs to env profile operations
    }

    const resolved = await this.resolveProfilesFromProject(args);
    if (resolved.sshProfile) {
      return this.validation.ensureString(String(resolved.sshProfile), 'ssh_profile');
    }

    throw new Error('ssh_profile_name is required (or configure project target.ssh_profile)');
  }

  async loadEnvBundle(envProfileName) {
    const profile = await this.profileService.getProfile(envProfileName, ENV_PROFILE_TYPE);
    const vars = { ...(profile.data?.variables || {}) };
    const secrets = { ...(profile.secrets || {}) };
    return {
      name: envProfileName,
      variables: { ...vars, ...secrets },
      variable_keys: Object.keys({ ...vars, ...secrets }).sort(),
      secret_keys: Object.keys(secrets).sort(),
    };
  }

  async profileUpsert(profileName, params) {
    const name = this.validation.ensureString(profileName, 'Profile name');

    const description = params.description !== undefined ? String(params.description) : undefined;

    let secrets;
    if (params.secrets === null) {
      secrets = null;
    } else if (params.env !== undefined || params.variables !== undefined || params.secrets !== undefined) {
      const fromEnv = normalizeStringMap(params.env, 'env', { allowNull: true }) || {};
      const fromVars = normalizeStringMap(params.variables, 'variables', { allowNull: true }) || {};
      const fromSecrets = normalizeStringMap(params.secrets, 'secrets', { allowNull: true }) || {};
      secrets = { ...fromEnv, ...fromVars, ...fromSecrets };
    }

    await this.profileService.setProfile(name, {
      type: ENV_PROFILE_TYPE,
      data: { description },
      secrets,
    });

    const stored = await this.profileService.getProfile(name, ENV_PROFILE_TYPE);
    const keys = stored.secrets ? Object.keys(stored.secrets).sort() : [];

    return {
      success: true,
      profile: {
        name,
        type: ENV_PROFILE_TYPE,
        description: stored.data?.description,
        keys,
      },
    };
  }

  async profileGet(profileName, includeSecrets = false) {
    const name = this.validation.ensureString(profileName, 'Profile name');
    const profile = await this.profileService.getProfile(name, ENV_PROFILE_TYPE);

    const legacyVars = isPlainObject(profile.data?.variables) ? profile.data.variables : {};
    const secretVars = profile.secrets || {};
    const keys = Object.keys({ ...legacyVars, ...secretVars }).sort();

    const allow = isTruthy(process.env.SENTRYFROGG_ALLOW_SECRET_EXPORT) || isTruthy(process.env.SF_ALLOW_SECRET_EXPORT);
    if (includeSecrets && allow) {
      return { success: true, profile };
    }

    return {
      success: true,
      profile: {
        name: profile.name,
        type: profile.type,
        data: {
          ...(profile.data || {}),
          variables: keys,
        },
        secrets: keys,
        secrets_redacted: true,
      },
    };
  }

  async profileList() {
    const profiles = await this.profileService.listProfiles(ENV_PROFILE_TYPE);
    return { success: true, profiles };
  }

  async profileDelete(profileName) {
    const name = this.validation.ensureString(profileName, 'Profile name');
    await this.profileService.deleteProfile(name);
    return { success: true, profile: name };
  }

  async writeRemote(args) {
    const envProfileName = await this.resolveEnvProfileName(args);
    const sshProfileName = await this.resolveSshProfileName(args);

    let remotePath = args.remote_path !== undefined
      ? this.validation.ensureString(args.remote_path, 'remote_path', { trim: false })
      : undefined;
    const mode = args.mode !== undefined ? Number(args.mode) : 0o600;
    const mkdirs = args.mkdirs === true;
    const overwrite = args.overwrite === true;
    const keepBackup = args.backup === true;

    const bundle = await this.loadEnvBundle(envProfileName);
    const content = renderDotenv(bundle.variables);

    const projectDefaults = !remotePath ? await this.resolveProfilesFromProject(args) : null;
    if (!remotePath) {
      if (projectDefaults?.envPath) {
        remotePath = this.validation.ensureString(String(projectDefaults.envPath), 'remote_path', { trim: false });
      } else if (projectDefaults?.cwd) {
        const cwd = this.validation.ensureString(String(projectDefaults.cwd), 'cwd', { trim: false });
        remotePath = path.posix.join(cwd, '.env');
      } else {
        throw new Error('remote_path is required (or configure project target.env_path / target.cwd)');
      }
    }

    const randomToken = () => crypto.randomBytes(6).toString('hex');

    let keptBackupPath = null;

    await this.sshManager.withSftp({ profile_name: sshProfileName }, async (sftp) => {
      const stat = (candidate) => new Promise((resolve, reject) => {
        sftp.stat(candidate, (error, result) => (error ? reject(error) : resolve(result)));
      });
      const rename = (from, to) => new Promise((resolve, reject) => {
        sftp.rename(from, to, (error) => (error ? reject(error) : resolve()));
      });
      const unlink = (candidate) => new Promise((resolve, reject) => {
        sftp.unlink(candidate, (error) => (error ? reject(error) : resolve()));
      });
      const chmod = (candidate, chmodMode) => new Promise((resolve, reject) => {
        if (typeof sftp.chmod !== 'function') {
          resolve();
          return;
        }
        sftp.chmod(candidate, chmodMode, (error) => (error ? reject(error) : resolve()));
      });

      if (mkdirs) {
        await this.sshManager.ensureRemoteDir(sftp, remotePath);
      }

      let exists = false;
      try {
        await stat(remotePath);
        exists = true;
      } catch (error) {
        if (error && (error.code === 2 || error.code === 'ENOENT')) {
          exists = false;
        } else {
          throw error;
        }
      }

      if (exists && !overwrite) {
        throw new Error(`Remote path already exists: ${remotePath}`);
      }

      const tmpPath = `${remotePath}.tmp-${process.pid}-${Date.now()}-${randomToken()}`;
      const backupPath = exists ? `${remotePath}.bak-${Date.now()}-${randomToken()}` : null;
      let movedToBackup = false;

      const writeTmp = () => new Promise((resolve, reject) => {
        const stream = sftp.createWriteStream(tmpPath, { mode });
        let done = false;
        const finalize = (error) => {
          if (done) {
            return;
          }
          done = true;
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        };

        stream.on('error', finalize);
        stream.on('close', () => finalize());
        stream.on('finish', () => finalize());
        stream.end(content);
      });

      try {
        await writeTmp();
        await chmod(tmpPath, mode);

        if (exists && overwrite && backupPath) {
          await rename(remotePath, backupPath);
          movedToBackup = true;
        }

        await rename(tmpPath, remotePath);
        await chmod(remotePath, mode);

        if (movedToBackup && !keepBackup) {
          await unlink(backupPath).catch(() => null);
        } else if (movedToBackup && keepBackup) {
          keptBackupPath = backupPath;
        }
      } catch (error) {
        await unlink(tmpPath).catch(() => null);
        if (movedToBackup && backupPath) {
          await rename(backupPath, remotePath).catch(() => null);
        }
        throw error;
      }
    });

    const response = {
      success: true,
      ssh_profile_name: sshProfileName,
      env_profile_name: envProfileName,
      remote_path: remotePath,
      overwrite,
      variables: { count: bundle.variable_keys.length, keys: bundle.variable_keys },
    };

    if (keptBackupPath) {
      response.backup_path = keptBackupPath;
    }

    return response;
  }

  async runRemote(args) {
    const envProfileName = await this.resolveEnvProfileName(args);
    const sshProfileName = await this.resolveSshProfileName(args);
    const command = this.validation.ensureString(args.command, 'command', { trim: false });

    const defaults = !args.cwd ? await this.resolveProfilesFromProject(args) : null;
    const cwd = args.cwd !== undefined
      ? args.cwd
      : (defaults?.cwd ? String(defaults.cwd) : undefined);

    const bundle = await this.loadEnvBundle(envProfileName);
    const env = Object.fromEntries(
      Object.entries(bundle.variables).map(([key, value]) => [normalizeEnvKey(key), String(value ?? '')])
    );

    const result = await this.sshManager.execCommand({
      profile_name: sshProfileName,
      command,
      cwd,
      env,
      stdin: args.stdin,
      timeout_ms: args.timeout_ms,
      pty: args.pty,
    });

    return {
      success: result.exitCode === 0,
      ssh_profile_name: sshProfileName,
      env_profile_name: envProfileName,
      variables: { count: bundle.variable_keys.length, keys: bundle.variable_keys },
      command: result.command,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      duration_ms: result.duration_ms,
    };
  }

  getStats() {
    return {};
  }

  async cleanup() {
    return;
  }
}

module.exports = EnvManager;
