#!/usr/bin/env node

/**
 * 🔐 SSH manager.
 */

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { Client } = require('ssh2');
const Constants = require('../constants/Constants.cjs');
const { isTruthy } = require('../utils/featureFlags.cjs');
const { expandHomePath } = require('../utils/userPaths.cjs');

function profileKey(profileName) {
  return profileName;
}

function normalizeHostKeyPolicy(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized === 'accept') {
    return 'accept';
  }
  if (normalized === 'tofu') {
    return 'tofu';
  }
  if (normalized === 'pin') {
    return 'pin';
  }
  throw new Error(`Unknown host_key_policy: ${normalized}`);
}

function normalizeFingerprintSha256(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const trimmed = String(value).trim();
  if (!trimmed) {
    return null;
  }
  const withoutPadding = trimmed.replace(/=+$/g, '');
  if (/^sha256:/i.test(withoutPadding)) {
    return `SHA256:${withoutPadding.slice(7)}`;
  }
  return `SHA256:${withoutPadding}`;
}

function fingerprintHostKeySha256(key) {
  if (!Buffer.isBuffer(key)) {
    throw new Error('SSH host key is not a Buffer');
  }
  const hash = crypto.createHash('sha256').update(key).digest('base64');
  return `SHA256:${hash.replace(/=+$/g, '')}`;
}

function escapeShellValue(value) {
  const str = String(value);
  return `'${str.replace(/'/g, "'\\''")}'`;
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizePublicKeyLine(raw) {
  const normalized = String(raw ?? '').replace(/\r/g, '');
  const lines = normalized
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));

  if (lines.length === 0) {
    throw new Error('public_key must contain a single key line');
  }

  if (lines.length > 1) {
    throw new Error('public_key must be a single key line');
  }

  const line = lines[0];
  if (line.includes('\0')) {
    throw new Error('public_key must not contain null bytes');
  }

  const tokens = line.split(/\s+/);
  if (tokens.length < 2) {
    throw new Error('public_key has invalid format (expected: "<type> <base64> [comment]")');
  }

  return line;
}

function parsePublicKeyTokens(line) {
  const tokens = String(line || '').trim().split(/\s+/);
  if (tokens.length < 2) {
    throw new Error('public_key has invalid format (expected: "<type> <base64> [comment]")');
  }
  return { keyType: tokens[0], keyBlob: tokens[1] };
}

function fingerprintPublicKeySha256(line) {
  const { keyBlob } = parsePublicKeyTokens(line);
  const bytes = Buffer.from(keyBlob, 'base64');
  const hash = crypto.createHash('sha256').update(bytes.length ? bytes : Buffer.from(keyBlob)).digest('base64');
  return `SHA256:${hash.replace(/=+$/, '')}`;
}

function isChannelOpenFailure(error) {
  const message = error && error.message !== undefined ? String(error.message) : String(error ?? '');
  return message.toLowerCase().includes('channel open failure');
}

class SSHManager {
  constructor(logger, security, validation, profileService, projectResolver, secretRefResolver) {
    this.logger = logger.child('ssh');
    this.security = security;
    this.validation = validation;
    this.profileService = profileService;
    this.projectResolver = projectResolver;
    this.secretRefResolver = secretRefResolver;
    this.connections = new Map();
    this.connecting = new Map();
    this.jobs = new Map();
    this.maxJobs = readPositiveInt(process.env.SENTRYFROGG_SSH_MAX_JOBS || process.env.SF_SSH_MAX_JOBS) || 200;
    this.stats = {
      commands: 0,
      profiles_created: 0,
      errors: 0,
      sftp_ops: 0,
      jobs_created: 0,
    };
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
      case 'profile_test':
        return this.profileTest(args);
      case 'authorized_keys_add':
        return this.authorizedKeysAdd(args);
      case 'exec':
        return this.execCommand(args);
      case 'exec_detached':
        return this.execDetached(args);
      case 'job_status':
        return this.jobStatus(args);
      case 'job_wait':
        return this.jobWait(args);
      case 'job_logs_tail':
        return this.jobLogsTail(args);
      case 'job_kill':
        return this.jobKill(args);
      case 'job_forget':
        return this.jobForget(args);
      case 'batch':
        return this.batch(args);
      case 'system_info':
        return this.systemInfo(args);
      case 'check_host':
        return this.checkHost(args);
      case 'sftp_list':
        return this.sftpList(args);
      case 'sftp_exists':
        return this.sftpExists(args);
      case 'sftp_upload':
        return this.sftpUpload(args);
      case 'sftp_download':
        return this.sftpDownload(args);
      default:
        throw new Error(`Unknown SSH action: ${action}`);
    }
  }

  async resolvePublicKeyLine(args) {
    if (args.public_key !== undefined) {
      return normalizePublicKeyLine(this.validation.ensureString(args.public_key, 'public_key', { trim: false }));
    }

    if (args.public_key_path !== undefined) {
      const publicKeyPath = this.validation.ensureString(args.public_key_path, 'public_key_path', { trim: false });
      const raw = await fs.readFile(expandHomePath(publicKeyPath), 'utf8');
      return normalizePublicKeyLine(raw);
    }

    throw new Error('public_key or public_key_path is required');
  }

  async authorizedKeysAdd(args = {}) {
    const publicKeyLine = await this.resolvePublicKeyLine(args);
    const { keyType, keyBlob } = parsePublicKeyTokens(publicKeyLine);
    const fingerprint = fingerprintPublicKeySha256(publicKeyLine);

    const authorizedKeysPath = args.authorized_keys_path !== undefined
      ? this.validation.ensureString(args.authorized_keys_path, 'authorized_keys_path', { trim: false })
      : undefined;

    const script = [
      'set -eu',
      'umask 077',
      'auth_path="${AUTH_KEYS_PATH:-"$HOME/.ssh/authorized_keys"}"',
      'ssh_dir="${auth_path%/*}"',
      'mkdir -p "$ssh_dir"',
      'chmod 700 "$ssh_dir" 2>/dev/null || true',
      '[ -f "$auth_path" ] || : > "$auth_path"',
      'chmod 600 "$auth_path" 2>/dev/null || true',
      'IFS= read -r key_line',
      'key_line="$(printf %s "$key_line" | tr -d \'\\r\')"',
      'set -- $key_line',
      'key_type="${1:-}"',
      'key_blob="${2:-}"',
      '[ -n "$key_type" ] && [ -n "$key_blob" ] || { echo "invalid_key" >&2; exit 2; }',
      'if awk -v t="$key_type" -v b="$key_blob" \'$0 ~ /^[[:space:]]*#/ { next } { for (i = 1; i <= NF; i++) if ($i == t && (i + 1) <= NF && $(i+1) == b) { found = 1; exit } } END { exit found ? 0 : 1 }\' "$auth_path"; then',
      '  echo present',
      'else',
      '  printf "%s\\n" "$key_line" >> "$auth_path"',
      '  echo added',
      'fi',
    ].join('\n');

    const env = authorizedKeysPath
      ? { ...(args.env || {}), AUTH_KEYS_PATH: authorizedKeysPath }
      : args.env;

    const result = await this.execCommand({
      ...args,
      command: script,
      env,
      stdin: `${publicKeyLine}\n`,
      pty: false,
    });

    const marker = String(result.stdout || '').trim().split('\n').pop();
    if (result.exitCode !== 0) {
      throw new Error(`authorized_keys_add failed: ${result.stderr || marker || 'unknown error'}`);
    }

    return {
      success: marker === 'added' || marker === 'present',
      changed: marker === 'added',
      key_type: keyType,
      key_fingerprint_sha256: fingerprint,
      authorized_keys_path: authorizedKeysPath || '~/.ssh/authorized_keys',
    };
  }

  async loadPrivateKey(connection) {
    if (connection.private_key) {
      return connection.private_key;
    }

    if (connection.private_key_path) {
      return fs.readFile(expandHomePath(connection.private_key_path), 'utf8');
    }

    return undefined;
  }

  async resolveConnection(args) {
    if (args.connection) {
      return { connection: { ...args.connection }, profileName: undefined };
    }

    const profileName = await this.resolveProfileName(args.profile_name, args);
    if (!profileName) {
      throw new Error('SSH connection requires profile_name or connection');
    }

    const profile = await this.profileService.getProfile(profileName, 'ssh');
    const data = { ...(profile.data || {}) };
    const secrets = { ...(profile.secrets || {}) };

    if (secrets.password) {
      data.password = secrets.password;
    }
    if (secrets.private_key) {
      data.private_key = secrets.private_key;
    }
    if (secrets.passphrase) {
      data.passphrase = secrets.passphrase;
    }

    return { connection: data, profileName };
  }

  buildConnectConfig(connection) {
    const config = {
      host: connection.host,
      port: this.validation.ensurePort(connection.port, Constants.NETWORK.SSH_DEFAULT_PORT),
      username: connection.username,
      readyTimeout: connection.ready_timeout ?? Constants.NETWORK.TIMEOUT_SSH_READY,
      keepaliveInterval: connection.keepalive_interval ?? Constants.NETWORK.KEEPALIVE_INTERVAL,
    };

    if (connection.keepalive_count_max !== undefined) {
      config.keepaliveCountMax = connection.keepalive_count_max;
    }

    return config;
  }

  async materializeConnection(connection, args = {}) {
    const resolvedConnection = this.secretRefResolver
      ? await this.secretRefResolver.resolveDeep(connection, args)
      : connection;

    const config = this.buildConnectConfig(resolvedConnection);

    const policyInput = normalizeHostKeyPolicy(args.host_key_policy ?? resolvedConnection.host_key_policy);
    const expectedFingerprint = normalizeFingerprintSha256(
      args.host_key_fingerprint_sha256 ?? resolvedConnection.host_key_fingerprint_sha256
    );

    const policy = policyInput || (expectedFingerprint ? 'pin' : 'accept');
    if (policy === 'pin' && !expectedFingerprint) {
      throw new Error('host_key_fingerprint_sha256 is required for host_key_policy=pin');
    }

    if (policy !== 'accept') {
      const state = {
        policy,
        expected_fingerprint_sha256: expectedFingerprint,
        observed_fingerprint_sha256: null,
        tofu_persist: policy === 'tofu' && !expectedFingerprint,
      };

      config.hostVerifier = (key) => {
        const observed = fingerprintHostKeySha256(key);
        state.observed_fingerprint_sha256 = observed;
        if (expectedFingerprint && observed !== expectedFingerprint) {
          return false;
        }
        return true;
      };

      config.__sentryfrogg_host_key_state = state;
    }

    const privateKey = await this.loadPrivateKey(resolvedConnection);
    if (privateKey) {
      config.privateKey = privateKey;
      if (resolvedConnection.passphrase) {
        config.passphrase = resolvedConnection.passphrase;
      }
    } else if (resolvedConnection.password) {
      config.password = resolvedConnection.password;
    } else {
      throw new Error('Provide password or private_key for SSH connection');
    }

    return config;
  }

  async maybePersistTofuHostKey(profileName, hostKeyState) {
    if (!profileName || typeof profileName !== 'string') {
      return false;
    }
    if (!this.profileService) {
      return false;
    }
    if (!hostKeyState || typeof hostKeyState !== 'object') {
      return false;
    }
    if (hostKeyState.policy !== 'tofu' || hostKeyState.tofu_persist !== true) {
      return false;
    }

    const fingerprint = hostKeyState.observed_fingerprint_sha256;
    if (!fingerprint || typeof fingerprint !== 'string') {
      return false;
    }

    await this.profileService.setProfile(profileName, {
      type: 'ssh',
      data: {
        host_key_policy: 'tofu',
        host_key_fingerprint_sha256: fingerprint,
      },
    });

    return true;
  }

  async profileUpsert(profileName, params) {
    const name = this.validation.ensureString(profileName, 'Profile name');
    const connection = params.connection || {};

    const secrets = {
      password: connection.password,
      private_key: connection.private_key,
      passphrase: connection.passphrase,
    };

    const data = { ...connection };
    delete data.password;
    delete data.private_key;
    delete data.passphrase;

    await this.profileTest({ connection });
    await this.profileService.setProfile(name, {
      type: 'ssh',
      data,
      secrets,
    });
    this.stats.profiles_created += 1;

    return {
      success: true,
      profile: {
        name,
        ...data,
        auth: secrets.private_key ? 'private_key' : 'password',
      },
    };
  }

  async resolveProfileName(profileName, args = {}) {
    if (profileName) {
      return this.validation.ensureString(profileName, 'Profile name');
    }

    if (this.projectResolver) {
      const context = await this.projectResolver.resolveContext(args);
      const sshProfile = context?.target?.ssh_profile;
      if (!sshProfile) {
        if (context) {
          throw new Error(`Project target '${context.targetName}' is missing ssh_profile`);
        }
      } else {
        return this.validation.ensureString(String(sshProfile), 'Profile name');
      }
    }

    const profiles = await this.profileService.listProfiles('ssh');
    if (profiles.length === 1) {
      return profiles[0].name;
    }

    if (profiles.length === 0) {
      return undefined;
    }

    throw new Error('profile_name is required when multiple profiles exist');
  }

  async profileGet(profileName, includeSecrets = false) {
    const name = this.validation.ensureString(profileName, 'Profile name');
    const profile = await this.profileService.getProfile(name, 'ssh');

    const allow = isTruthy(process.env.SENTRYFROGG_ALLOW_SECRET_EXPORT) || isTruthy(process.env.SF_ALLOW_SECRET_EXPORT);
    if (includeSecrets && allow) {
      return { success: true, profile };
    }

    const secretKeys = profile.secrets ? Object.keys(profile.secrets).sort() : [];
    return {
      success: true,
      profile: {
        name: profile.name,
        type: profile.type,
        data: profile.data,
        secrets: secretKeys,
        secrets_redacted: true,
      },
    };
  }

  async profileList() {
    const profiles = await this.profileService.listProfiles('ssh');
    return { success: true, profiles };
  }

  async profileDelete(profileName) {
    const name = this.validation.ensureString(profileName, 'Profile name');
    await this.profileService.deleteProfile(name);
    this.connections.delete(profileKey(name));
    return { success: true, profile: name };
  }

  async profileTest(args) {
    const { connection } = await this.resolveConnection(args);
    const entry = await this.createClient(await this.materializeConnection(connection, args), Symbol('test'));
    try {
      await this.exec(entry.client, 'echo "test"');
    } finally {
      entry.client.end();
    }
    return { success: true };
  }

  async withClient(profileName, args, handler) {
    if (typeof args === 'function') {
      handler = args;
      args = {};
    }

    const profile = await this.profileService.getProfile(profileName, 'ssh');
    const key = profileKey(profileName);

    let entry = this.connections.get(key);
    if (!entry || entry.closed) {
      let pending = this.connecting.get(key);
      if (!pending) {
        const connection = this.mergeProfile(profile);
        pending = (async () => {
          const created = await this.createClient(await this.materializeConnection(connection, args), key);
          this.connections.set(key, created);
          return created;
        })();
        this.connecting.set(key, pending);
        pending.finally(() => {
          this.connecting.delete(key);
        });
      }
      entry = await pending;
    }

    while (entry.busy) {
      await entry.busy;
    }

    let release;
    entry.busy = new Promise((resolve) => {
      release = resolve;
    });

    try {
      return await handler(entry.client);
    } finally {
      release();
      entry.busy = null;
    }
  }

  async resetProfileConnection(profileName, reason) {
    const key = profileKey(profileName);
    const entry = this.connections.get(key);
    this.connecting.delete(key);

    if (entry) {
      try {
        entry.closed = true;
      } catch (error) {
        // ignore
      }
      this.connections.delete(key);
      try {
        entry.client?.end?.();
      } catch (error) {
        // ignore
      }
      try {
        entry.client?.destroy?.();
      } catch (error) {
        // ignore
      }
    }

    this.logger.warn('Reset SSH connection', { profile: profileName, reason });
    return { success: true, reset: Boolean(entry) };
  }

  async withClientRetry(profileName, args, handler) {
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.withClient(profileName, args, handler);
      } catch (error) {
        lastError = error;
        if (attempt === 0 && isChannelOpenFailure(error)) {
          await this.resetProfileConnection(profileName, error.message);
          continue;
        }
        throw error;
      }
    }
    throw lastError;
  }

  mergeProfile(profile) {
    const connection = { ...(profile.data || {}) };
    const secrets = { ...(profile.secrets || {}) };

    if (secrets.password) {
      connection.password = secrets.password;
    }
    if (secrets.private_key) {
      connection.private_key = secrets.private_key;
    }
    if (secrets.passphrase) {
      connection.passphrase = secrets.passphrase;
    }

    return connection;
  }

  async createClient(connectConfig, key) {
    return new Promise((resolve, reject) => {
      const client = new Client();
      let resolved = false;

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          client.destroy();
          reject(new Error('SSH connection timeout'));
        }
      }, connectConfig.readyTimeout ?? Constants.NETWORK.TIMEOUT_SSH_READY);

      client
        .on('ready', () => {
          if (resolved) {
            return;
          }
          resolved = true;
          clearTimeout(timeout);

          client.on('close', () => {
            const entry = this.connections.get(key);
            if (entry) {
              entry.closed = true;
              this.connections.delete(key);
            }
          });

          const hostKeyState = connectConfig.__sentryfrogg_host_key_state;
          const profileName = typeof key === 'string' ? key : null;

          (async () => {
            if (profileName) {
              await this.maybePersistTofuHostKey(profileName, hostKeyState).catch((error) => {
                this.logger.warn('Failed to persist TOFU host key fingerprint', { profile: profileName, error: error.message });
              });
            }
            resolve({ client, busy: null, closed: false });
          })().catch((error) => {
            client.destroy();
            reject(error);
          });
        })
        .on('error', (error) => {
          if (resolved) {
            return;
          }
          resolved = true;
          clearTimeout(timeout);
          client.destroy();
          reject(error);
        });

      client.connect(connectConfig);
    });
  }

  async getSftp(client) {
    return new Promise((resolve, reject) => {
      client.sftp((error, sftp) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(sftp);
      });
    });
  }

  async withSftp(args, handler) {
    const { connection, profileName } = await this.resolveConnection(args);
    if (profileName) {
      return this.withClientRetry(profileName, args, async (client) => {
        const sftp = await this.getSftp(client);
        return handler(sftp);
      });
    }

    const entry = await this.createClient(await this.materializeConnection(connection, args), Symbol('sftp-inline'));
    try {
      const sftp = await this.getSftp(entry.client);
      return await handler(sftp);
    } finally {
      entry.client.end();
    }
  }

  async ensureRemoteDir(sftp, remotePath) {
    const dir = path.posix.dirname(remotePath);
    if (!dir || dir === '.' || dir === '/') {
      return;
    }
    const parts = dir.split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
      current += `/${part}`;
      try {
        await new Promise((resolve, reject) => {
          sftp.stat(current, (error) => {
            if (!error) {
              resolve();
            } else if (error.code === 2) {
              sftp.mkdir(current, (mkdirError) => {
                if (mkdirError && mkdirError.code !== 4) {
                  reject(mkdirError);
                } else {
                  resolve();
                }
              });
            } else {
              reject(error);
            }
          });
        });
      } catch (error) {
        if (error.code !== 4) {
          throw error;
        }
      }
    }
  }

  resolveToolCallBudgetMs() {
    const fromEnv = readPositiveInt(process.env.SENTRYFROGG_TOOL_CALL_TIMEOUT_MS || process.env.SF_TOOL_CALL_TIMEOUT_MS);
    return fromEnv ?? Constants.NETWORK.TIMEOUT_MCP_TOOL_CALL;
  }

  resolveExecDefaultTimeoutMs() {
    const fromEnv = readPositiveInt(process.env.SENTRYFROGG_SSH_EXEC_TIMEOUT_MS || process.env.SF_SSH_EXEC_TIMEOUT_MS);
    return fromEnv ?? Constants.NETWORK.TIMEOUT_SSH_EXEC_DEFAULT;
  }

  resolveDetachedStartTimeoutMs() {
    const fromEnv = readPositiveInt(process.env.SENTRYFROGG_SSH_DETACHED_START_TIMEOUT_MS || process.env.SF_SSH_DETACHED_START_TIMEOUT_MS);
    return fromEnv ?? Constants.NETWORK.TIMEOUT_SSH_DETACHED_START;
  }

  registerJob(job) {
    if (!job || typeof job !== 'object' || !job.job_id) {
      return;
    }
    this.jobs.set(job.job_id, job);
    while (this.jobs.size > this.maxJobs) {
      const oldest = this.jobs.keys().next().value;
      if (!oldest) {
        break;
      }
      this.jobs.delete(oldest);
    }
    this.stats.jobs_created += 1;
  }

  buildCommand(command, cwd) {
    const trimmed = this.security.cleanCommand(command);
    if (cwd) {
      return `cd ${escapeShellValue(cwd)} && ${trimmed}`;
    }
    return trimmed;
  }

  async execCommand(args) {
    const { connection, profileName } = await this.resolveConnection(args);
    const command = this.buildCommand(args.command, args.cwd);

    const budgetMs = this.resolveToolCallBudgetMs();
    const requestedTimeoutMs = readPositiveInt(args.timeout_ms);
    if (requestedTimeoutMs && requestedTimeoutMs > budgetMs) {
      const started = await this.execDetached({
        ...args,
        timeout_ms: this.resolveDetachedStartTimeoutMs(),
      });
      return {
        ...started,
        detached: true,
        requested_timeout_ms: requestedTimeoutMs,
      };
    }

    const effectiveTimeoutMs = Math.min(
      requestedTimeoutMs ?? this.resolveExecDefaultTimeoutMs(),
      budgetMs
    );
    const execArgs = { ...args, timeout_ms: effectiveTimeoutMs };

    const options = {
      env: args.env,
      pty: args.pty,
    };

    try {
      const result = profileName
        ? await this.withClientRetry(profileName, execArgs, (client) => this.exec(client, command, options, execArgs))
        : await this.execOnce(connection, command, options, execArgs);

      this.stats.commands += 1;
      return {
        success: result.exitCode === 0 && result.timedOut !== true,
        command,
        timeout_ms: effectiveTimeoutMs,
        requested_timeout_ms: requestedTimeoutMs,
        ...result,
      };
    } catch (error) {
      this.stats.errors += 1;
      this.logger.error('SSH command failed', { profile: profileName, error: error.message });
      throw error;
    }
  }

  async execDetached(args) {
    const { connection, profileName } = await this.resolveConnection(args);
    const command = this.buildCommand(args.command, args.cwd);

    const logPath = args.log_path !== undefined
      ? this.validation.ensureString(args.log_path, 'log_path', { trim: false })
      : `/tmp/sentryfrogg-detached-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.log`;
    const pidPath = args.pid_path !== undefined
      ? this.validation.ensureString(args.pid_path, 'pid_path', { trim: false })
      : `${logPath}.pid`;

    const exitPath = args.exit_path !== undefined
      ? this.validation.ensureString(args.exit_path, 'exit_path', { trim: false })
      : `${logPath}.exit`;

    const jobId = crypto.randomUUID();

    const inner = [
      `(${command})`,
      'rc=$?',
      `echo "$rc" > ${escapeShellValue(exitPath)}`,
      'exit "$rc"',
    ].join('\n');

    const detachedCommand = [
      `rm -f ${escapeShellValue(pidPath)} ${escapeShellValue(exitPath)} 2>/dev/null || true`,
      `nohup sh -lc ${escapeShellValue(inner)} > ${escapeShellValue(logPath)} 2>&1 < /dev/null & echo $! > ${escapeShellValue(pidPath)}`,
      `cat ${escapeShellValue(pidPath)}`,
    ].join('; ');

    const options = {
      env: args.env,
      pty: false,
    };

    const execArgs = {
      ...args,
      timeout_ms: Math.min(
        readPositiveInt(args.timeout_ms) ?? this.resolveDetachedStartTimeoutMs(),
        this.resolveToolCallBudgetMs()
      ),
    };

    try {
      const result = profileName
        ? await this.withClientRetry(profileName, execArgs, (client) => this.exec(client, detachedCommand, options, execArgs))
        : await this.execOnce(connection, detachedCommand, options, execArgs);

      const match = String(result.stdout || '').match(/(\d+)\s*$/);
      const pid = match ? Number(match[1]) : null;

      this.registerJob({
        job_id: jobId,
        created_at: new Date().toISOString(),
        profile_name: profileName || null,
        pid,
        log_path: logPath,
        pid_path: pidPath,
        exit_path: exitPath,
      });

      this.stats.commands += 1;
      return {
        success: result.exitCode === 0 && Number.isInteger(pid),
        job_id: jobId,
        command,
        detached_command: detachedCommand,
        pid,
        log_path: logPath,
        pid_path: pidPath,
        exit_path: exitPath,
        start_timeout_ms: execArgs.timeout_ms,
        ...result,
      };
    } catch (error) {
      this.stats.errors += 1;
      this.logger.error('SSH detached command failed', { profile: profileName, error: error.message });
      throw error;
    }
  }

  async execOnce(connection, command, options, args) {
    const connectConfig = await this.materializeConnection(connection, args);
    const entry = await this.createClient(connectConfig, Symbol('inline'));
    try {
      return await this.exec(entry.client, command, options, args);
    } finally {
      entry.client.end();
    }
  }

  exec(client, command, options = {}, args = {}) {
    const timeoutMs = readPositiveInt(args.timeout_ms);
    const stdin = args.stdin;

    return new Promise((resolve, reject) => {
      const started = Date.now();
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;

      client.exec(command, options, (error, stream) => {
        if (error) {
          reject(error);
          return;
        }

        const finalize = (fn) => {
          if (settled) {
            return;
          }
          settled = true;
          fn();
        };

        let timeout;
        let hardTimeout;
        if (timeoutMs) {
          timeout = setTimeout(() => {
            timedOut = true;
            try {
              stream.close();
            } catch (closeError) {
              // ignore
            }
          }, timeoutMs);

          hardTimeout = setTimeout(() => {
            timedOut = true;
            try {
              stream.close();
            } catch (closeError) {
              // ignore
            }
            try {
              stream.destroy();
            } catch (destroyError) {
              // ignore
            }
          }, timeoutMs + 2000);
        }

        stream
          .on('close', (code, signal) => {
            if (timeout) {
              clearTimeout(timeout);
            }
            if (hardTimeout) {
              clearTimeout(hardTimeout);
            }
            finalize(() => {
              resolve({
                stdout: stdout.trim(),
                stderr: stderr.trim(),
                exitCode: code,
                signal,
                timedOut,
                duration_ms: Date.now() - started,
              });
            });
          })
          .on('error', (streamError) => {
            if (timeout) {
              clearTimeout(timeout);
            }
            if (hardTimeout) {
              clearTimeout(hardTimeout);
            }
            finalize(() => reject(streamError));
          })
          .on('data', (data) => {
            stdout += data.toString();
          });

        stream.stderr.on('data', (data) => {
          stderr += data.toString();
        });

        if (stdin !== undefined && stdin !== null) {
          stream.end(String(stdin));
        }
      });
    });
  }

  resolveJobSpec(args = {}, { requirePid = true } = {}) {
    const jobId = args.job_id !== undefined && args.job_id !== null
      ? this.validation.ensureString(args.job_id, 'job_id')
      : null;

    const fromRegistry = jobId ? this.jobs.get(jobId) : null;
    if (jobId && !fromRegistry) {
      throw new Error(`Unknown job_id: ${jobId}`);
    }

    const logPathRaw = args.log_path ?? fromRegistry?.log_path;
    const logPath = logPathRaw !== undefined && logPathRaw !== null
      ? this.validation.ensureString(logPathRaw, 'log_path', { trim: false })
      : undefined;

    const pidPathRaw = args.pid_path ?? fromRegistry?.pid_path ?? (logPath ? `${logPath}.pid` : undefined);
    const pidPath = pidPathRaw !== undefined && pidPathRaw !== null
      ? this.validation.ensureString(pidPathRaw, 'pid_path', { trim: false })
      : undefined;

    const exitPathRaw = args.exit_path ?? fromRegistry?.exit_path ?? (logPath ? `${logPath}.exit` : undefined);
    const exitPath = exitPathRaw !== undefined && exitPathRaw !== null
      ? this.validation.ensureString(exitPathRaw, 'exit_path', { trim: false })
      : undefined;

    const pidRaw = args.pid ?? fromRegistry?.pid;
    const pid = pidRaw === undefined || pidRaw === null || pidRaw === '' ? null : Number(pidRaw);
    if (pid !== null && (!Number.isFinite(pid) || !Number.isInteger(pid) || pid <= 0)) {
      throw new Error('pid must be a positive integer');
    }

    if (requirePid && !pid && !pidPath) {
      throw new Error('job requires pid or pid_path (or job_id with known pid_path)');
    }

    return {
      job_id: jobId,
      profile_name: fromRegistry?.profile_name ?? null,
      pid,
      pid_path: pidPath,
      log_path: logPath,
      exit_path: exitPath,
    };
  }

  async jobStatus(args = {}) {
    const job = this.resolveJobSpec(args);
    const budgetMs = this.resolveToolCallBudgetMs();
    const timeoutMs = Math.min(readPositiveInt(args.timeout_ms) ?? 10000, budgetMs);

    const pidValue = job.pid ? String(job.pid) : '';
    const pidPath = job.pid_path ? String(job.pid_path) : '';
    const exitPath = job.exit_path ? String(job.exit_path) : '';
    const logPath = job.log_path ? String(job.log_path) : '';

    const script = [
      'set -u',
      `PID_VALUE=${escapeShellValue(pidValue)}`,
      `PID_PATH=${escapeShellValue(pidPath)}`,
      `EXIT_PATH=${escapeShellValue(exitPath)}`,
      `LOG_PATH=${escapeShellValue(logPath)}`,
      'pid="$PID_VALUE"',
      'if [ -z "$pid" ] && [ -n "$PID_PATH" ] && [ -f "$PID_PATH" ]; then pid="$(cat "$PID_PATH" 2>/dev/null | tr -dc \'0-9\' | head -c 32)"; fi',
      'running=0',
      'if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then running=1; fi',
      'exit_code=""',
      'if [ -n "$EXIT_PATH" ] && [ -f "$EXIT_PATH" ]; then exit_code="$(cat "$EXIT_PATH" 2>/dev/null | tr -d "\\r\\n" | head -c 64)"; fi',
      'log_bytes=""',
      'if [ -n "$LOG_PATH" ] && [ -f "$LOG_PATH" ]; then log_bytes="$(wc -c < "$LOG_PATH" 2>/dev/null | tr -d " ")"; fi',
      'echo "__SF_PID__=$pid"',
      'echo "__SF_RUNNING__=$running"',
      'echo "__SF_EXIT_CODE__=$exit_code"',
      'echo "__SF_LOG_BYTES__=$log_bytes"',
    ].join('\n');

    const exec = await this.execCommand({
      ...args,
      cwd: undefined,
      pty: false,
      timeout_ms: timeoutMs,
      command: script,
    });

    const lines = String(exec.stdout || '').split(/\n/);
    const pick = (prefix) => {
      const line = lines.find((item) => item.startsWith(prefix));
      return line ? line.slice(prefix.length) : '';
    };

    const pidStr = pick('__SF_PID__=');
    const runningStr = pick('__SF_RUNNING__=');
    const exitStr = pick('__SF_EXIT_CODE__=');
    const logBytesStr = pick('__SF_LOG_BYTES__=');

    const resolvedPid = pidStr ? Number(pidStr) : null;
    const running = runningStr === '1';
    const exitCode = exitStr === '' ? null : Number(exitStr);
    const exited = exitStr !== '' && Number.isFinite(exitCode);
    const logBytes = logBytesStr === '' ? null : Number(logBytesStr);

    return {
      success: true,
      job_id: job.job_id,
      pid: Number.isInteger(resolvedPid) ? resolvedPid : job.pid,
      running,
      exited,
      exit_code: exited ? exitCode : null,
      log_path: job.log_path,
      pid_path: job.pid_path,
      exit_path: job.exit_path,
      log_bytes: Number.isFinite(logBytes) ? logBytes : null,
    };
  }

  async jobWait(args = {}) {
    const budgetMs = this.resolveToolCallBudgetMs();
    const requested = readPositiveInt(args.timeout_ms) ?? 30000;
    const timeoutMs = Math.min(requested, budgetMs);
    const pollMs = Math.min(readPositiveInt(args.poll_interval_ms) ?? 1000, 5000);
    const started = Date.now();

    let status = await this.jobStatus({ ...args, timeout_ms: Math.min(10000, budgetMs) });
    while (!status.exited && Date.now() - started + pollMs <= timeoutMs) {
      await sleep(pollMs);
      status = await this.jobStatus({ ...args, timeout_ms: Math.min(10000, budgetMs) });
    }

    const waitedMs = Date.now() - started;
    return {
      success: true,
      completed: status.exited,
      timed_out: !status.exited,
      waited_ms: waitedMs,
      timeout_ms: timeoutMs,
      poll_interval_ms: pollMs,
      status,
    };
  }

  async jobLogsTail(args = {}) {
    const spec = this.resolveJobSpec(args, { requirePid: false });
    const logPath = spec.log_path;
    if (!logPath) {
      throw new Error('log_path is required (or job_id with known log_path)');
    }

    const lines = Math.min(readPositiveInt(args.lines) ?? 200, 2000);
    const budgetMs = this.resolveToolCallBudgetMs();
    const timeoutMs = Math.min(readPositiveInt(args.timeout_ms) ?? 10000, budgetMs);

    const cmd = `tail -n ${lines} ${escapeShellValue(logPath)} 2>/dev/null || true`;
    const out = await this.execCommand({
      ...args,
      cwd: undefined,
      pty: false,
      timeout_ms: timeoutMs,
      command: cmd,
    });

    return {
      success: true,
      job_id: spec.job_id,
      log_path: logPath,
      lines,
      text: out.stdout || '',
    };
  }

  async jobKill(args = {}) {
    const job = this.resolveJobSpec(args);
    const budgetMs = this.resolveToolCallBudgetMs();
    const timeoutMs = Math.min(readPositiveInt(args.timeout_ms) ?? 10000, budgetMs);

    const rawSignal = args.signal === undefined || args.signal === null ? 'TERM' : String(args.signal).trim();
    if (!/^[A-Za-z0-9]+$/.test(rawSignal)) {
      throw new Error('signal must be an alphanumeric string (e.g. TERM, KILL, 9)');
    }
    const signal = rawSignal.toUpperCase();

    const pidValue = job.pid ? String(job.pid) : '';
    const pidPath = job.pid_path ? String(job.pid_path) : '';

    const script = [
      'set -u',
      `PID_VALUE=${escapeShellValue(pidValue)}`,
      `PID_PATH=${escapeShellValue(pidPath)}`,
      `SIG=${escapeShellValue(signal)}`,
      'pid="$PID_VALUE"',
      'if [ -z "$pid" ] && [ -n "$PID_PATH" ] && [ -f "$PID_PATH" ]; then pid="$(cat "$PID_PATH" 2>/dev/null | tr -dc \'0-9\' | head -c 32)"; fi',
      'if [ -z "$pid" ]; then echo "__SF_KILL__=no_pid"; exit 2; fi',
      'kill -s "$SIG" "$pid" 2>/dev/null || kill "$pid" 2>/dev/null',
      'echo "__SF_KILL__=ok"',
    ].join('\n');

    const exec = await this.execCommand({
      ...args,
      cwd: undefined,
      pty: false,
      timeout_ms: timeoutMs,
      command: script,
    });

    if (exec.exitCode !== 0) {
      throw new Error(exec.stderr || `job_kill failed (exitCode=${exec.exitCode})`);
    }

    return {
      success: true,
      job_id: job.job_id,
      pid: job.pid,
      pid_path: job.pid_path,
      signal,
    };
  }

  async jobForget(args = {}) {
    const jobId = this.validation.ensureString(args.job_id, 'job_id');
    const existed = this.jobs.delete(jobId);
    return { success: true, job_id: jobId, removed: existed };
  }

  async batch(args) {
    const commands = Array.isArray(args.commands) ? args.commands : [];
    if (commands.length === 0) {
      throw new Error('commands must be a non-empty array');
    }

    const parallel = !!args.parallel;
    const stopOnError = args.stop_on_error !== false;

    if (parallel) {
      const results = await Promise.all(
        commands.map((command) => this.execCommand({ ...args, ...command }))
      );
      return { success: results.every((item) => item.exitCode === 0), results };
    }

    const results = [];
    for (const command of commands) {
      try {
        const result = await this.execCommand({ ...args, ...command });
        results.push(result);
        if (stopOnError && result.exitCode !== 0) {
          break;
        }
      } catch (error) {
        results.push({ success: false, command: command.command, error: error.message });
        if (stopOnError) {
          break;
        }
      }
    }

    return { success: results.every((item) => item.exitCode === 0), results };
  }

  async sftpList(args) {
    const remotePath = this.validation.ensureString(args.path || '.', 'Path');
    const recursive = args.recursive === true;
    const maxDepth = Number.isInteger(args.max_depth) ? args.max_depth : 3;

    const entries = [];

    const walk = (sftp, currentPath, depth) => new Promise((resolve, reject) => {
      sftp.readdir(currentPath, (error, list) => {
        if (error) {
          reject(error);
          return;
        }
        const run = async () => {
          for (const entry of list) {
            const isDir = entry.attrs && typeof entry.attrs.isDirectory === 'function'
              ? entry.attrs.isDirectory()
              : (entry.attrs?.mode & 0o40000) === 0o40000;
            const fullPath = path.posix.join(currentPath, entry.filename);
            entries.push({
              path: fullPath,
              filename: entry.filename,
              longname: entry.longname,
              type: isDir ? 'dir' : 'file',
              size: entry.attrs?.size,
              mode: entry.attrs?.mode,
              mtime: entry.attrs?.mtime,
              atime: entry.attrs?.atime,
            });
            if (recursive && isDir && depth < maxDepth) {
              await walk(sftp, fullPath, depth + 1);
            }
          }
        };

        run().then(resolve).catch(reject);
      });
    });

    await this.withSftp(args, async (sftp) => {
      await walk(sftp, remotePath, 0);
    });

    this.stats.sftp_ops += 1;
    return { success: true, path: remotePath, entries };
  }

  async sftpExists(args) {
    const remotePath = this.validation.ensureString(args.remote_path ?? args.path, 'remote_path');
    const timeoutMs = Math.min(readPositiveInt(args.timeout_ms) ?? 10000, this.resolveToolCallBudgetMs());

    let exists = false;
    let stat = null;

    await this.withSftp(args, async (sftp) => {
      await new Promise((resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(() => {
          if (settled) {
            return;
          }
          settled = true;
          reject(new Error('sftp_exists timeout'));
        }, timeoutMs);

        sftp.stat(remotePath, (error, attrs) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timeout);

          if (!error) {
            exists = true;
            stat = attrs
              ? {
                size: attrs.size,
                mode: attrs.mode,
                uid: attrs.uid,
                gid: attrs.gid,
                atime: attrs.atime,
                mtime: attrs.mtime,
              }
              : null;
            resolve();
            return;
          }

          if (error.code === 2) {
            exists = false;
            stat = null;
            resolve();
            return;
          }

          reject(error);
        });
      });
    });

    this.stats.sftp_ops += 1;
    return {
      success: true,
      remote_path: remotePath,
      exists,
      stat,
    };
  }

  async sftpUpload(args) {
    const localPath = expandHomePath(this.validation.ensureString(args.local_path, 'local_path'));
    const remotePath = this.validation.ensureString(args.remote_path, 'remote_path');
    const overwrite = args.overwrite === true;

    await this.withSftp(args, async (sftp) => {
      if (!overwrite) {
        await new Promise((resolve, reject) => {
          sftp.stat(remotePath, (error) => {
            if (!error) {
              reject(new Error(`Remote path already exists: ${remotePath}`));
              return;
            }
            if (error.code !== 2) {
              reject(error);
              return;
            }
            resolve();
          });
        });
      }

      if (args.mkdirs) {
        await this.ensureRemoteDir(sftp, remotePath);
      }

      await new Promise((resolve, reject) => {
        sftp.fastPut(localPath, remotePath, (error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });

      if (args.preserve_mtime) {
        const stat = await fs.stat(localPath);
        await new Promise((resolve, reject) => {
          sftp.utimes(remotePath, stat.atime, stat.mtime, (error) => {
            if (error) {
              reject(error);
            } else {
              resolve();
            }
          });
        });
      }
    });

    this.stats.sftp_ops += 1;
    return { success: true, local_path: localPath, remote_path: remotePath };
  }

  async sftpDownload(args) {
    const remotePath = this.validation.ensureString(args.remote_path, 'remote_path');
    const localPath = expandHomePath(this.validation.ensureString(args.local_path, 'local_path'));
    const overwrite = args.overwrite === true;

    if (!overwrite) {
      try {
        await fs.access(localPath);
        throw new Error(`Local path already exists: ${localPath}`);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      }
    }

    if (args.mkdirs) {
      await fs.mkdir(path.dirname(localPath), { recursive: true });
    }

    await this.withSftp(args, async (sftp) => {
      await new Promise((resolve, reject) => {
        sftp.fastGet(remotePath, localPath, (error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });

      if (args.preserve_mtime) {
        await new Promise((resolve, reject) => {
          sftp.stat(remotePath, (error, stat) => {
            if (error) {
              reject(error);
            } else {
              fs.utimes(localPath, stat.atime, stat.mtime)
                .then(resolve)
                .catch(reject);
            }
          });
        });
      }
    });

    this.stats.sftp_ops += 1;
    return { success: true, remote_path: remotePath, local_path: localPath };
  }

  async systemInfo(args) {
    const commands = {
      uname: 'uname -a',
      os: 'cat /etc/os-release 2>/dev/null || sw_vers 2>/dev/null || echo "OS info unavailable"',
      disk: 'df -h',
      memory: 'free -h 2>/dev/null || vm_stat',
      uptime: 'uptime',
    };

    const report = {};
    for (const [key, cmd] of Object.entries(commands)) {
      try {
        const result = await this.execCommand({ ...args, command: cmd });
        report[key] = { success: true, ...result };
      } catch (error) {
        report[key] = { success: false, error: error.message };
      }
    }

    return { success: true, system_info: report };
  }

  async checkHost(args) {
    try {
      const result = await this.execCommand({
        ...args,
        command: 'echo "Connection OK" && whoami && hostname',
      });
      return { success: result.exitCode === 0, response: result.stdout };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  getStats() {
    return { ...this.stats, active_connections: this.connections.size, active_jobs: this.jobs.size };
  }

  async cleanup() {
    for (const entry of this.connections.values()) {
      try {
        entry.client.end();
      } catch (error) {
        // ignore cleanup errors
      }
    }
    this.connections.clear();
  }
}

module.exports = SSHManager;
