#!/usr/bin/env node
"use strict";
// @ts-nocheck
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * 🔐 SSH manager.
 */
const crypto = require('crypto');
const fsSync = require('node:fs');
const fs = require('fs/promises');
const path = require('path');
const { Client } = require('ssh2');
const Constants = require('../constants/Constants');
const { isTruthy } = require('../utils/featureFlags');
const { expandHomePath } = require('../utils/userPaths');
const { redactText } = require('../utils/redact');
const ToolError = require('../errors/ToolError');
const { unknownActionError } = require('../utils/toolErrors');
const { resolveContextRepoRoot, buildToolCallFileRef, createArtifactWriteStream, writeTextArtifact, writeBinaryArtifact, } = require('../utils/artifacts');
const DEFAULT_MAX_CAPTURE_BYTES = 256 * 1024;
const DEFAULT_MAX_INLINE_BYTES = 16 * 1024;
const SSH_ACTIONS = [
    'profile_upsert',
    'profile_get',
    'profile_list',
    'profile_delete',
    'connect',
    'authorized_keys_add',
    'exec',
    'exec_detached',
    'exec_follow',
    'deploy_file',
    'job_status',
    'job_wait',
    'job_logs_tail',
    'tail_job',
    'follow_job',
    'job_kill',
    'job_forget',
    'batch',
    'system_info',
    'check_host',
    'sftp_list',
    'sftp_exists',
    'sftp_upload',
    'sftp_download',
];
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
    throw ToolError.invalidParams({
        field: 'host_key_policy',
        message: `Unknown host_key_policy: ${normalized}`,
        hint: 'Use one of: accept, tofu, pin.',
    });
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
        throw ToolError.internal({ code: 'SSH_HOST_KEY_INVALID', message: 'SSH host key is not a Buffer' });
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
function resolveStreamToArtifactMode() {
    const raw = process.env.SENTRYFROGG_SSH_STREAM_TO_ARTIFACT
        || process.env.SF_SSH_STREAM_TO_ARTIFACT
        || process.env.SENTRYFROGG_STREAM_TO_ARTIFACT
        || process.env.SF_STREAM_TO_ARTIFACT;
    if (raw === undefined || raw === null) {
        return null;
    }
    const normalized = String(raw).trim().toLowerCase();
    if (!normalized) {
        return null;
    }
    if (normalized === 'full') {
        return 'full';
    }
    if (normalized === 'capped') {
        return 'capped';
    }
    return isTruthy(normalized) ? 'capped' : null;
}
function isStreamToArtifactEnabled() {
    return Boolean(resolveStreamToArtifactMode());
}
function collectSecretValues(map) {
    if (!map || typeof map !== 'object' || Array.isArray(map)) {
        return null;
    }
    const out = [];
    for (const raw of Object.values(map)) {
        if (typeof raw !== 'string') {
            continue;
        }
        const trimmed = raw.trim();
        if (trimmed.length < 6) {
            continue;
        }
        out.push(trimmed);
        if (out.length >= 32) {
            break;
        }
    }
    return out.length ? out : null;
}
function normalizePublicKeyLine(raw) {
    const normalized = String(raw ?? '').replace(/\r/g, '');
    const lines = normalized
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('#'));
    if (lines.length === 0) {
        throw ToolError.invalidParams({
            field: 'public_key',
            message: 'public_key must contain a single key line',
            hint: 'Expected a single line: "<type> <base64> [comment]".',
        });
    }
    if (lines.length > 1) {
        throw ToolError.invalidParams({
            field: 'public_key',
            message: 'public_key must be a single key line',
            hint: 'Remove extra lines/comments; keep exactly one key line.',
        });
    }
    const line = lines[0];
    if (line.includes('\0')) {
        throw ToolError.invalidParams({ field: 'public_key', message: 'public_key must not contain null bytes' });
    }
    const tokens = line.split(/\s+/);
    if (tokens.length < 2) {
        throw ToolError.invalidParams({
            field: 'public_key',
            message: 'public_key has invalid format',
            hint: 'Expected: "<type> <base64> [comment]".',
        });
    }
    return line;
}
function parsePublicKeyTokens(line) {
    const tokens = String(line || '').trim().split(/\s+/);
    if (tokens.length < 2) {
        throw ToolError.invalidParams({
            field: 'public_key',
            message: 'public_key has invalid format',
            hint: 'Expected: "<type> <base64> [comment]".',
        });
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
    constructor(logger, security, validation, profileService, projectResolver, secretRefResolver, jobService) {
        this.logger = logger.child('ssh');
        this.security = security;
        this.validation = validation;
        this.profileService = profileService;
        this.projectResolver = projectResolver;
        this.secretRefResolver = secretRefResolver;
        this.jobService = jobService || null;
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
            case 'exec_follow':
                return this.execFollow(args);
            case 'deploy_file':
                return this.deployFile(args);
            case 'job_status':
                return this.jobStatus(args);
            case 'job_wait':
                return this.jobWait(args);
            case 'job_logs_tail':
                return this.jobLogsTail(args);
            case 'tail_job':
                return this.tailJob(args);
            case 'follow_job':
                return this.followJob(args);
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
                throw unknownActionError({ tool: 'ssh', action, knownActions: SSH_ACTIONS });
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
        throw ToolError.invalidParams({
            field: 'public_key',
            message: 'public_key or public_key_path is required',
            hint: "Example: { action: 'authorized_keys_add', public_key: 'ssh-ed25519 AAAA... comment' }",
        });
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
            throw ToolError.internal({
                code: 'SSH_AUTHORIZED_KEYS_ADD_FAILED',
                message: `authorized_keys_add failed: ${result.stderr || marker || 'unknown error'}`,
                hint: 'Check authorized_keys_path permissions and that the key format is valid.',
            });
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
            throw ToolError.invalidParams({
                field: 'profile_name',
                message: 'SSH connection requires profile_name or connection',
                hint: "Example: { action: 'exec', profile_name: 'my-ssh', command: 'uname -a' }",
            });
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
        const expectedFingerprint = normalizeFingerprintSha256(args.host_key_fingerprint_sha256 ?? resolvedConnection.host_key_fingerprint_sha256);
        const policy = policyInput || (expectedFingerprint ? 'pin' : 'accept');
        if (policy === 'pin' && !expectedFingerprint) {
            throw ToolError.invalidParams({
                field: 'host_key_fingerprint_sha256',
                message: 'host_key_fingerprint_sha256 is required for host_key_policy=pin',
                hint: "Set { host_key_policy: 'accept' } (insecure), or provide { host_key_fingerprint_sha256: 'SHA256:...' }.",
            });
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
        }
        else if (resolvedConnection.password) {
            config.password = resolvedConnection.password;
        }
        else {
            throw ToolError.invalidParams({
                field: 'connection',
                message: 'Provide password or private_key for SSH connection',
                hint: 'Set connection.password, or connection.private_key/private_key_path (optionally passphrase).',
            });
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
                    throw ToolError.invalidParams({
                        field: 'profile_name',
                        message: `Project target '${context.targetName}' is missing ssh_profile`,
                        hint: 'Add ssh_profile to the target (projects.json) or pass profile_name explicitly.',
                        details: { target: context.targetName },
                    });
                }
            }
            else {
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
        throw ToolError.invalidParams({
            field: 'profile_name',
            message: 'profile_name is required when multiple profiles exist',
            hint: `Known profiles: ${profiles.slice(0, 20).map((p) => p.name).join(', ')}${profiles.length > 20 ? ', ...' : ''}.`,
            details: { known_profiles: profiles.map((p) => p.name) },
        });
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
        }
        finally {
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
        }
        finally {
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
            }
            catch (error) {
                // ignore
            }
            this.connections.delete(key);
            try {
                entry.client?.end?.();
            }
            catch (error) {
                // ignore
            }
            try {
                entry.client?.destroy?.();
            }
            catch (error) {
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
            }
            catch (error) {
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
        }
        finally {
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
                        }
                        else if (error.code === 2) {
                            sftp.mkdir(current, (mkdirError) => {
                                if (mkdirError && mkdirError.code !== 4) {
                                    reject(mkdirError);
                                }
                                else {
                                    resolve();
                                }
                            });
                        }
                        else {
                            reject(error);
                        }
                    });
                });
            }
            catch (error) {
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
    resolveExecHardGraceMs() {
        const fromEnv = readPositiveInt(process.env.SENTRYFROGG_SSH_EXEC_HARD_GRACE_MS || process.env.SF_SSH_EXEC_HARD_GRACE_MS);
        return fromEnv ?? Constants.NETWORK.TIMEOUT_SSH_EXEC_HARD_GRACE;
    }
    resolveDetachedStartTimeoutMs() {
        const fromEnv = readPositiveInt(process.env.SENTRYFROGG_SSH_DETACHED_START_TIMEOUT_MS || process.env.SF_SSH_DETACHED_START_TIMEOUT_MS);
        return fromEnv ?? Constants.NETWORK.TIMEOUT_SSH_DETACHED_START;
    }
    resolveExecMaxCaptureBytes() {
        const fromEnv = readPositiveInt(process.env.SENTRYFROGG_SSH_MAX_CAPTURE_BYTES
            || process.env.SF_SSH_MAX_CAPTURE_BYTES
            || process.env.SENTRYFROGG_MAX_CAPTURE_BYTES
            || process.env.SF_MAX_CAPTURE_BYTES);
        return fromEnv ?? DEFAULT_MAX_CAPTURE_BYTES;
    }
    resolveExecMaxInlineBytes() {
        const fromEnv = readPositiveInt(process.env.SENTRYFROGG_SSH_MAX_INLINE_BYTES
            || process.env.SF_SSH_MAX_INLINE_BYTES
            || process.env.SENTRYFROGG_MAX_INLINE_BYTES
            || process.env.SF_MAX_INLINE_BYTES);
        return fromEnv ?? DEFAULT_MAX_INLINE_BYTES;
    }
    registerJob(job) {
        if (!job || typeof job !== 'object' || !job.job_id) {
            return;
        }
        if (this.jobService) {
            this.jobService.upsert({
                ...job,
                kind: job.kind || 'ssh_detached',
                status: job.status || 'running',
                provider: job.provider || {
                    tool: 'mcp_ssh_manager',
                    profile_name: job.profile_name || null,
                    pid: job.pid,
                    pid_path: job.pid_path,
                    log_path: job.log_path,
                    exit_path: job.exit_path,
                },
            });
        }
        else {
            this.jobs.set(job.job_id, job);
            while (this.jobs.size > this.maxJobs) {
                const oldest = this.jobs.keys().next().value;
                if (!oldest) {
                    break;
                }
                this.jobs.delete(oldest);
            }
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
            const followed = await this.execFollow({
                ...args,
                timeout_ms: requestedTimeoutMs,
            });
            return {
                ...followed,
                detached: true,
                requested_timeout_ms: requestedTimeoutMs,
            };
        }
        const effectiveTimeoutMs = Math.min(requestedTimeoutMs ?? this.resolveExecDefaultTimeoutMs(), budgetMs);
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
        }
        catch (error) {
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
            timeout_ms: Math.min(readPositiveInt(args.timeout_ms) ?? this.resolveDetachedStartTimeoutMs(), this.resolveToolCallBudgetMs()),
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
        }
        catch (error) {
            this.stats.errors += 1;
            this.logger.error('SSH detached command failed', { profile: profileName, error: error.message });
            throw error;
        }
    }
    async execFollow(args = {}) {
        const startedAt = Date.now();
        const budgetMs = this.resolveToolCallBudgetMs();
        const startTimeoutMs = Math.min(readPositiveInt(args.start_timeout_ms) ?? this.resolveDetachedStartTimeoutMs(), budgetMs);
        const started = await this.execDetached({ ...args, timeout_ms: startTimeoutMs });
        if (!started || started.success !== true || typeof started.job_id !== 'string' || !started.job_id.trim()) {
            return {
                success: false,
                code: 'START_FAILED',
                job_id: started?.job_id ?? null,
                start: started,
            };
        }
        const elapsed = Date.now() - startedAt;
        const remaining = Math.max(0, budgetMs - elapsed);
        const requestedWaitMs = readPositiveInt(args.timeout_ms) ?? 30000;
        const waitTimeoutMs = Math.max(1, Math.min(requestedWaitMs, remaining));
        const follow = await this.followJob({
            ...args,
            job_id: started.job_id,
            timeout_ms: waitTimeoutMs,
            lines: args.lines,
        });
        return {
            success: Boolean(follow?.success),
            job_id: started.job_id,
            start: {
                success: true,
                pid: started.pid ?? null,
                log_path: started.log_path,
                pid_path: started.pid_path,
                exit_path: started.exit_path,
                start_timeout_ms: started.start_timeout_ms ?? startTimeoutMs,
            },
            wait: follow?.wait ?? null,
            status: follow?.status ?? null,
            logs: follow?.logs ?? null,
        };
    }
    async execOnce(connection, command, options, args) {
        const connectConfig = await this.materializeConnection(connection, args);
        const entry = await this.createClient(connectConfig, Symbol('inline'));
        try {
            return await this.exec(entry.client, command, options, args);
        }
        finally {
            entry.client.end();
        }
    }
    exec(client, command, options = {}, args = {}) {
        const requestedTimeoutMs = readPositiveInt(args.timeout_ms);
        const stdin = args.stdin;
        const budgetMs = this.resolveToolCallBudgetMs();
        const timeoutMs = requestedTimeoutMs ? Math.min(requestedTimeoutMs, budgetMs) : null;
        const hardGraceMs = timeoutMs
            ? Math.min(this.resolveExecHardGraceMs(), Math.max(0, budgetMs - timeoutMs))
            : 0;
        const maxCaptureBytes = this.resolveExecMaxCaptureBytes();
        const maxInlineBytes = this.resolveExecMaxInlineBytes();
        const traceId = args.trace_id || 'run';
        const spanId = args.span_id || crypto.randomUUID();
        const contextRoot = resolveContextRepoRoot();
        const streamArtifactsMode = contextRoot ? resolveStreamToArtifactMode() : null;
        const streamArtifactsRequested = Boolean(streamArtifactsMode);
        const extraSecretValues = collectSecretValues(args.env);
        const redactionOptions = extraSecretValues
            ? { extraSecretValues, maxString: Number.POSITIVE_INFINITY }
            : { maxString: Number.POSITIVE_INFINITY };
        return new Promise((resolve, reject) => {
            const started = Date.now();
            const stdoutState = { total: 0, captured: 0, truncated: false };
            const stderrState = { total: 0, captured: 0, truncated: false };
            const stdoutChunks = [];
            const stderrChunks = [];
            const stdoutInline = { captured: 0, truncated: false };
            const stderrInline = { captured: 0, truncated: false };
            let timedOut = false;
            let settled = false;
            let streamArtifactsEnabled = streamArtifactsRequested;
            let stdoutWriter = null;
            let stderrWriter = null;
            const artifactLimit = streamArtifactsMode === 'full' ? Number.POSITIVE_INFINITY : maxCaptureBytes;
            const captureMemoryChunk = (chunk, state, target) => {
                const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ''));
                state.total += buf.length;
                if (state.captured >= maxCaptureBytes) {
                    state.truncated = true;
                    return;
                }
                const remaining = maxCaptureBytes - state.captured;
                if (buf.length <= remaining) {
                    target.push(buf);
                    state.captured += buf.length;
                    return;
                }
                target.push(buf.subarray(0, remaining));
                state.captured += remaining;
                state.truncated = true;
            };
            const captureInlineChunk = (chunk, inlineState, target) => {
                if (inlineState.captured >= maxInlineBytes) {
                    inlineState.truncated = true;
                    return;
                }
                const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ''));
                const remaining = maxInlineBytes - inlineState.captured;
                if (buf.length <= remaining) {
                    target.push(buf);
                    inlineState.captured += buf.length;
                    return;
                }
                target.push(buf.subarray(0, remaining));
                inlineState.captured += remaining;
                inlineState.truncated = true;
            };
            const writeArtifactChunk = (chunk, state, writer, source) => {
                if (!writer) {
                    if (artifactLimit !== Number.POSITIVE_INFINITY) {
                        state.truncated = true;
                    }
                    return;
                }
                const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ''));
                if (state.captured >= artifactLimit) {
                    if (artifactLimit !== Number.POSITIVE_INFINITY) {
                        state.truncated = true;
                    }
                    return;
                }
                const remaining = artifactLimit - state.captured;
                if (buf.length <= remaining) {
                    const ok = writer.stream.write(buf);
                    if (!ok && source && typeof source.pause === 'function') {
                        source.pause();
                        writer.stream.once('drain', () => source.resume());
                    }
                    state.captured += buf.length;
                    return;
                }
                const slice = buf.subarray(0, remaining);
                const ok = writer.stream.write(slice);
                if (!ok && source && typeof source.pause === 'function') {
                    source.pause();
                    writer.stream.once('drain', () => source.resume());
                }
                state.captured += remaining;
                state.truncated = true;
            };
            const startExec = async () => {
                if (streamArtifactsEnabled) {
                    try {
                        stdoutWriter = await createArtifactWriteStream(contextRoot, buildToolCallFileRef({ traceId, spanId, filename: 'stdout.log' }));
                        stderrWriter = await createArtifactWriteStream(contextRoot, buildToolCallFileRef({ traceId, spanId, filename: 'stderr.log' }));
                    }
                    catch (artifactError) {
                        streamArtifactsEnabled = false;
                        if (stdoutWriter) {
                            await stdoutWriter.abort().catch(() => null);
                            stdoutWriter = null;
                        }
                        if (stderrWriter) {
                            await stderrWriter.abort().catch(() => null);
                            stderrWriter = null;
                        }
                        this.logger.warn('Failed to initialize SSH artifact streams', { error: artifactError.message });
                    }
                }
                client.exec(command, options, (error, stream) => {
                    if (error) {
                        if (stdoutWriter) {
                            void stdoutWriter.abort().catch(() => null);
                            stdoutWriter = null;
                        }
                        if (stderrWriter) {
                            void stderrWriter.abort().catch(() => null);
                            stderrWriter = null;
                        }
                        reject(error);
                        return;
                    }
                    const finalize = (fn) => {
                        if (settled) {
                            return;
                        }
                        settled = true;
                        Promise.resolve()
                            .then(fn)
                            .then((value) => resolve(value))
                            .catch((err) => reject(err));
                    };
                    const buildResult = async ({ exitCode, signal, hardTimedOut = false }) => {
                        if (streamArtifactsEnabled) {
                            const stdoutInlineBuffer = stdoutInline.captured
                                ? Buffer.concat(stdoutChunks, stdoutInline.captured)
                                : Buffer.alloc(0);
                            const stderrInlineBuffer = stderrInline.captured
                                ? Buffer.concat(stderrChunks, stderrInline.captured)
                                : Buffer.alloc(0);
                            const stdoutInlineTruncated = stdoutInline.truncated;
                            const stderrInlineTruncated = stderrInline.truncated;
                            let stdoutRef = null;
                            let stderrRef = null;
                            if (stdoutWriter) {
                                if (stdoutState.captured > 0) {
                                    try {
                                        const written = await stdoutWriter.finalize();
                                        stdoutRef = { uri: written.uri, rel: written.rel, bytes: written.bytes };
                                    }
                                    catch (artifactError) {
                                        this.logger.warn('Failed to finalize SSH stdout artifact', { error: artifactError.message });
                                        await stdoutWriter.abort().catch(() => null);
                                    }
                                }
                                else {
                                    await stdoutWriter.abort().catch(() => null);
                                }
                                stdoutWriter = null;
                            }
                            if (stderrWriter) {
                                if (stderrState.captured > 0) {
                                    try {
                                        const written = await stderrWriter.finalize();
                                        stderrRef = { uri: written.uri, rel: written.rel, bytes: written.bytes };
                                    }
                                    catch (artifactError) {
                                        this.logger.warn('Failed to finalize SSH stderr artifact', { error: artifactError.message });
                                        await stderrWriter.abort().catch(() => null);
                                    }
                                }
                                else {
                                    await stderrWriter.abort().catch(() => null);
                                }
                                stderrWriter = null;
                            }
                            return {
                                stdout: stdoutInlineBuffer.toString('utf8'),
                                stderr: stderrInlineBuffer.toString('utf8'),
                                stdout_bytes: stdoutState.total,
                                stderr_bytes: stderrState.total,
                                stdout_captured_bytes: stdoutState.captured,
                                stderr_captured_bytes: stderrState.captured,
                                stdout_truncated: stdoutState.truncated,
                                stderr_truncated: stderrState.truncated,
                                stdout_inline_truncated: stdoutInlineTruncated,
                                stderr_inline_truncated: stderrInlineTruncated,
                                stdout_ref: stdoutRef,
                                stderr_ref: stderrRef,
                                exitCode,
                                signal,
                                timedOut,
                                hardTimedOut,
                                duration_ms: Date.now() - started,
                            };
                        }
                        const stdoutBuffer = stdoutState.captured
                            ? Buffer.concat(stdoutChunks, stdoutState.captured)
                            : Buffer.alloc(0);
                        const stderrBuffer = stderrState.captured
                            ? Buffer.concat(stderrChunks, stderrState.captured)
                            : Buffer.alloc(0);
                        const stdoutInlineBuffer = stdoutBuffer.length > maxInlineBytes
                            ? stdoutBuffer.subarray(0, maxInlineBytes)
                            : stdoutBuffer;
                        const stderrInlineBuffer = stderrBuffer.length > maxInlineBytes
                            ? stderrBuffer.subarray(0, maxInlineBytes)
                            : stderrBuffer;
                        const stdoutInlineTruncated = stdoutBuffer.length > maxInlineBytes;
                        const stderrInlineTruncated = stderrBuffer.length > maxInlineBytes;
                        const shouldWriteStdout = Boolean(contextRoot
                            && stdoutBuffer.length > 0
                            && (stdoutState.truncated || stdoutInlineTruncated));
                        const shouldWriteStderr = Boolean(contextRoot
                            && stderrBuffer.length > 0
                            && (stderrState.truncated || stderrInlineTruncated));
                        let stdoutRef = null;
                        let stderrRef = null;
                        if (shouldWriteStdout) {
                            try {
                                const ref = buildToolCallFileRef({ traceId, spanId, filename: 'stdout.log' });
                                const redacted = redactText(stdoutBuffer.toString('utf8'), redactionOptions);
                                const written = await writeTextArtifact(contextRoot, ref, redacted);
                                stdoutRef = { uri: written.uri, rel: written.rel, bytes: written.bytes };
                            }
                            catch (artifactError) {
                                this.logger.warn('Failed to write SSH stdout artifact', { error: artifactError.message });
                            }
                        }
                        if (shouldWriteStderr) {
                            try {
                                const ref = buildToolCallFileRef({ traceId, spanId, filename: 'stderr.log' });
                                const redacted = redactText(stderrBuffer.toString('utf8'), redactionOptions);
                                const written = await writeTextArtifact(contextRoot, ref, redacted);
                                stderrRef = { uri: written.uri, rel: written.rel, bytes: written.bytes };
                            }
                            catch (artifactError) {
                                this.logger.warn('Failed to write SSH stderr artifact', { error: artifactError.message });
                            }
                        }
                        return {
                            stdout: stdoutInlineBuffer.toString('utf8'),
                            stderr: stderrInlineBuffer.toString('utf8'),
                            stdout_bytes: stdoutState.total,
                            stderr_bytes: stderrState.total,
                            stdout_captured_bytes: stdoutBuffer.length,
                            stderr_captured_bytes: stderrBuffer.length,
                            stdout_truncated: stdoutState.truncated,
                            stderr_truncated: stderrState.truncated,
                            stdout_inline_truncated: stdoutInlineTruncated,
                            stderr_inline_truncated: stderrInlineTruncated,
                            stdout_ref: stdoutRef,
                            stderr_ref: stderrRef,
                            exitCode,
                            signal,
                            timedOut,
                            hardTimedOut,
                            duration_ms: Date.now() - started,
                        };
                    };
                    let timeout;
                    let hardTimeout;
                    if (timeoutMs) {
                        timeout = setTimeout(() => {
                            timedOut = true;
                            try {
                                stream.close();
                            }
                            catch (closeError) {
                                // ignore
                            }
                        }, timeoutMs);
                        hardTimeout = setTimeout(() => {
                            timedOut = true;
                            if (timeout) {
                                clearTimeout(timeout);
                            }
                            try {
                                stream.close();
                            }
                            catch (closeError) {
                                // ignore
                            }
                            try {
                                stream.destroy();
                            }
                            catch (destroyError) {
                                // ignore
                            }
                            try {
                                client.destroy();
                            }
                            catch (clientError) {
                                // ignore
                            }
                            finalize(() => buildResult({ exitCode: null, signal: null, hardTimedOut: true }));
                        }, timeoutMs + hardGraceMs);
                    }
                    stream
                        .on('close', (code, signal) => {
                        if (timeout) {
                            clearTimeout(timeout);
                        }
                        if (hardTimeout) {
                            clearTimeout(hardTimeout);
                        }
                        finalize(() => buildResult({ exitCode: code, signal }));
                    })
                        .on('error', (streamError) => {
                        if (timeout) {
                            clearTimeout(timeout);
                        }
                        if (hardTimeout) {
                            clearTimeout(hardTimeout);
                        }
                        finalize(async () => {
                            if (stdoutWriter) {
                                await stdoutWriter.abort().catch(() => null);
                                stdoutWriter = null;
                            }
                            if (stderrWriter) {
                                await stderrWriter.abort().catch(() => null);
                                stderrWriter = null;
                            }
                            throw streamError;
                        });
                    })
                        .on('data', (data) => {
                        if (streamArtifactsEnabled) {
                            const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data ?? ''));
                            stdoutState.total += buf.length;
                            captureInlineChunk(buf, stdoutInline, stdoutChunks);
                            writeArtifactChunk(buf, stdoutState, stdoutWriter, stream);
                            return;
                        }
                        captureMemoryChunk(data, stdoutState, stdoutChunks);
                    });
                    if (stream.stderr && typeof stream.stderr.on === 'function') {
                        stream.stderr.on('data', (data) => {
                            if (streamArtifactsEnabled) {
                                const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data ?? ''));
                                stderrState.total += buf.length;
                                captureInlineChunk(buf, stderrInline, stderrChunks);
                                writeArtifactChunk(buf, stderrState, stderrWriter, stream.stderr);
                                return;
                            }
                            captureMemoryChunk(data, stderrState, stderrChunks);
                        });
                    }
                    if (stdin !== undefined && stdin !== null) {
                        stream.end(String(stdin));
                    }
                });
            };
            void startExec().catch(reject);
        });
    }
    resolveJobSpec(args = {}, { requirePid = true } = {}) {
        const jobId = args.job_id !== undefined && args.job_id !== null
            ? this.validation.ensureString(args.job_id, 'job_id')
            : null;
        const fromRegistry = jobId
            ? (this.jobService ? this.jobService.get(jobId) : this.jobs.get(jobId))
            : null;
        const hasExplicitLocator = args.pid !== undefined
            || args.pid_path !== undefined
            || args.log_path !== undefined
            || args.exit_path !== undefined;
        if (jobId && !fromRegistry && !hasExplicitLocator) {
            return { job_id: jobId, not_found: true };
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
            throw ToolError.invalidParams({ field: 'pid', message: 'pid must be a positive integer' });
        }
        if (requirePid && !pid && !pidPath) {
            throw ToolError.invalidParams({
                field: 'pid',
                message: 'job requires pid or pid_path (or job_id with known pid_path)',
                hint: "Example: { action: 'job_status', pid_path: '/tmp/my.pid' }",
            });
        }
        return {
            job_id: jobId,
            not_found: false,
            profile_name: fromRegistry?.profile_name ?? null,
            pid,
            pid_path: pidPath,
            log_path: logPath,
            exit_path: exitPath,
        };
    }
    async jobStatus(args = {}) {
        const job = this.resolveJobSpec(args);
        if (job.not_found) {
            return { success: false, code: 'NOT_FOUND', job_id: job.job_id };
        }
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
        if (!status.success && status.code === 'NOT_FOUND') {
            return {
                success: false,
                code: 'NOT_FOUND',
                job_id: args.job_id,
            };
        }
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
        if (spec.not_found) {
            return { success: false, code: 'NOT_FOUND', job_id: spec.job_id };
        }
        const logPath = spec.log_path;
        if (!logPath) {
            throw ToolError.invalidParams({
                field: 'log_path',
                message: 'log_path is required (or job_id with known log_path)',
                hint: "Example: { action: 'job_logs_tail', log_path: '/tmp/app.log' }",
            });
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
    async tailJob(args = {}) {
        const lines = Math.min(readPositiveInt(args.lines) ?? 120, 2000);
        const budgetMs = this.resolveToolCallBudgetMs();
        const status = await this.jobStatus({ ...args, timeout_ms: Math.min(10000, budgetMs) });
        if (!status.success && status.code === 'NOT_FOUND') {
            return status;
        }
        const logs = await this.jobLogsTail({ ...args, lines, timeout_ms: Math.min(10000, budgetMs) });
        return {
            success: Boolean(status.success && logs.success),
            job_id: status.job_id ?? args.job_id,
            status,
            logs,
        };
    }
    async followJob(args = {}) {
        const lines = Math.min(readPositiveInt(args.lines) ?? 120, 2000);
        const budgetMs = this.resolveToolCallBudgetMs();
        const waitTimeoutMs = Math.min(readPositiveInt(args.timeout_ms) ?? 30000, budgetMs);
        const wait = await this.jobWait({ ...args, timeout_ms: waitTimeoutMs });
        if (!wait.success && wait.code === 'NOT_FOUND') {
            return wait;
        }
        const logs = await this.jobLogsTail({ ...args, lines, timeout_ms: Math.min(10000, budgetMs) });
        return {
            success: Boolean(wait.success && logs.success),
            job_id: wait.status?.job_id ?? args.job_id,
            wait,
            status: wait.status ?? null,
            logs,
        };
    }
    async computeLocalSha256Hex(filePath) {
        const hash = crypto.createHash('sha256');
        const stream = fsSync.createReadStream(filePath);
        for await (const chunk of stream) {
            hash.update(chunk);
        }
        return hash.digest('hex');
    }
    parseSha256FromOutput(text) {
        const match = String(text || '').match(/\b[a-fA-F0-9]{64}\b/);
        return match ? match[0].toLowerCase() : null;
    }
    buildRemoteSha256Command(remotePath) {
        const quoted = escapeShellValue(remotePath);
        return [
            'set -u',
            `PATH_ARG=${quoted}`,
            'if command -v sha256sum >/dev/null 2>&1; then sha256sum -- \"$PATH_ARG\" 2>/dev/null | awk \'{print $1}\'; exit 0; fi',
            'if command -v shasum >/dev/null 2>&1; then shasum -a 256 -- \"$PATH_ARG\" 2>/dev/null | awk \'{print $1}\'; exit 0; fi',
            'if command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 -- \"$PATH_ARG\" 2>/dev/null | awk \'{print $NF}\'; exit 0; fi',
            'echo \"__SF_NO_SHA256__\"',
            'exit 127',
        ].join('\n');
    }
    async deployFile(args = {}) {
        const started = Date.now();
        const localPath = expandHomePath(this.validation.ensureString(args.local_path, 'local_path'));
        const remotePath = this.validation.ensureString(args.remote_path, 'remote_path');
        const overwrite = args.overwrite !== undefined ? args.overwrite === true : true;
        const mkdirs = args.mkdirs === true;
        const preserveMtime = args.preserve_mtime === true;
        const localSha256 = await this.computeLocalSha256Hex(localPath);
        let uploadError = null;
        try {
            await this.sftpUpload({ ...args, local_path: localPath, remote_path: remotePath, overwrite, mkdirs, preserve_mtime: preserveMtime });
        }
        catch (error) {
            uploadError = error?.message || String(error);
            return {
                success: false,
                code: 'UPLOAD_FAILED',
                local_path: localPath,
                remote_path: remotePath,
                local_sha256: localSha256,
                error: uploadError,
                duration_ms: Date.now() - started,
            };
        }
        const verifyStarted = Date.now();
        const hashCmd = this.buildRemoteSha256Command(remotePath);
        const hashExec = await this.execCommand({
            ...args,
            cwd: undefined,
            pty: false,
            command: hashCmd,
        });
        const remoteSha256 = this.parseSha256FromOutput(hashExec.stdout);
        const verifyMs = Date.now() - verifyStarted;
        if (!remoteSha256) {
            return {
                success: false,
                code: 'REMOTE_HASH_FAILED',
                local_path: localPath,
                remote_path: remotePath,
                local_sha256: localSha256,
                remote_sha256: null,
                verify_ms: verifyMs,
                duration_ms: Date.now() - started,
                error: 'Unable to parse remote sha256 output',
                remote_stdout: hashExec.stdout,
                remote_stderr: hashExec.stderr,
                remote_exit_code: hashExec.exitCode,
            };
        }
        if (remoteSha256 !== localSha256) {
            return {
                success: false,
                code: 'HASH_MISMATCH',
                local_path: localPath,
                remote_path: remotePath,
                local_sha256: localSha256,
                remote_sha256: remoteSha256,
                verify_ms: verifyMs,
                duration_ms: Date.now() - started,
            };
        }
        const restartService = args.restart !== undefined && args.restart !== null && String(args.restart).trim().length
            ? String(args.restart).trim()
            : null;
        const restartCommand = args.restart_command !== undefined && args.restart_command !== null && String(args.restart_command).trim().length
            ? String(args.restart_command).trim()
            : null;
        if (restartService && restartCommand) {
            return {
                success: false,
                code: 'INVALID_RESTART',
                message: 'Provide only one of restart (service) or restart_command',
                local_path: localPath,
                remote_path: remotePath,
                local_sha256: localSha256,
                remote_sha256: remoteSha256,
                duration_ms: Date.now() - started,
            };
        }
        let restartResult = null;
        if (restartService || restartCommand) {
            const restartStarted = Date.now();
            const cmd = restartCommand || `systemctl restart ${escapeShellValue(restartService)} && systemctl is-active ${escapeShellValue(restartService)}`;
            const out = await this.execCommand({
                ...args,
                cwd: undefined,
                pty: false,
                command: cmd,
            });
            restartResult = {
                requested: true,
                service: restartService,
                exit_code: Number.isFinite(out.exitCode) ? out.exitCode : null,
                timed_out: Boolean(out.timedOut || out.hardTimedOut),
                restart_ms: Date.now() - restartStarted,
            };
            if (restartResult.exit_code !== 0 || restartResult.timed_out) {
                return {
                    success: false,
                    code: 'RESTART_FAILED',
                    local_path: localPath,
                    remote_path: remotePath,
                    local_sha256: localSha256,
                    remote_sha256: remoteSha256,
                    restart: restartResult,
                    duration_ms: Date.now() - started,
                };
            }
        }
        return {
            success: true,
            local_path: localPath,
            remote_path: remotePath,
            overwrite,
            mkdirs,
            preserve_mtime: preserveMtime,
            local_sha256: localSha256,
            remote_sha256: remoteSha256,
            verified: true,
            verify_ms: verifyMs,
            restart: restartResult,
            duration_ms: Date.now() - started,
        };
    }
    async jobKill(args = {}) {
        const job = this.resolveJobSpec(args);
        if (job.not_found) {
            return { success: false, code: 'NOT_FOUND', job_id: job.job_id };
        }
        const budgetMs = this.resolveToolCallBudgetMs();
        const timeoutMs = Math.min(readPositiveInt(args.timeout_ms) ?? 10000, budgetMs);
        const rawSignal = args.signal === undefined || args.signal === null ? 'TERM' : String(args.signal).trim();
        if (!/^[A-Za-z0-9]+$/.test(rawSignal)) {
            throw ToolError.invalidParams({
                field: 'signal',
                message: 'signal must be an alphanumeric string (e.g. TERM, KILL, 9)',
            });
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
            throw ToolError.internal({
                code: 'SSH_JOB_KILL_FAILED',
                message: exec.stderr || `job_kill failed (exitCode=${exec.exitCode})`,
                hint: 'Check that the PID exists and the SSH user has permissions to send signals.',
            });
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
        const removed = this.jobService ? this.jobService.forget(jobId) : this.jobs.delete(jobId);
        return { success: true, job_id: jobId, removed };
    }
    async batch(args) {
        const commands = Array.isArray(args.commands) ? args.commands : [];
        if (commands.length === 0) {
            throw ToolError.invalidParams({
                field: 'commands',
                message: 'commands must be a non-empty array',
                hint: "Example: { action: 'batch', commands: [{ command: 'uname -a' }, { command: 'whoami' }] }",
            });
        }
        const parallel = !!args.parallel;
        const stopOnError = args.stop_on_error !== false;
        if (parallel) {
            const results = await Promise.all(commands.map((command) => this.execCommand({ ...args, ...command })));
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
            }
            catch (error) {
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
                    }
                    else {
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
                        }
                        else {
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
        const tmpPath = `${localPath}.sentryfrogg.tmp-${crypto.randomBytes(4).toString('hex')}`;
        if (!overwrite) {
            try {
                await fs.access(localPath);
                throw ToolError.conflict({
                    code: 'LOCAL_PATH_EXISTS',
                    message: `Local path already exists: ${localPath}`,
                    hint: 'Set overwrite=true to replace it.',
                    details: { local_path: localPath },
                });
            }
            catch (error) {
                if (error.code !== 'ENOENT') {
                    throw error;
                }
            }
        }
        if (args.mkdirs) {
            await fs.mkdir(path.dirname(localPath), { recursive: true });
        }
        let remoteTimes = null;
        try {
            await this.withSftp(args, async (sftp) => {
                if (args.preserve_mtime) {
                    remoteTimes = await new Promise((resolve, reject) => {
                        sftp.stat(remotePath, (error, stat) => {
                            if (error) {
                                reject(error);
                            }
                            else {
                                resolve(stat);
                            }
                        });
                    });
                }
                await new Promise((resolve, reject) => {
                    sftp.fastGet(remotePath, tmpPath, (error) => {
                        if (error) {
                            reject(error);
                        }
                        else {
                            resolve();
                        }
                    });
                });
            });
        }
        catch (error) {
            await fs.rm(tmpPath, { force: true }).catch(() => null);
            if (error && (error.code === 2 || error.code === 'ENOENT')) {
                this.stats.sftp_ops += 1;
                return {
                    success: false,
                    remote_path: remotePath,
                    local_path: localPath,
                    code: 'ENOENT',
                    error: error.message || 'Remote path does not exist',
                };
            }
            throw error;
        }
        if (remoteTimes && typeof remoteTimes === 'object') {
            await fs.utimes(tmpPath, remoteTimes.atime, remoteTimes.mtime).catch(() => null);
        }
        const localExists = await fs.access(localPath).then(() => true).catch(() => false);
        let backupPath = null;
        if (overwrite && localExists) {
            backupPath = `${localPath}.sentryfrogg.bak-${crypto.randomBytes(4).toString('hex')}`;
            await fs.rename(localPath, backupPath);
        }
        try {
            await fs.rename(tmpPath, localPath);
        }
        catch (error) {
            await fs.rm(tmpPath, { force: true }).catch(() => null);
            if (backupPath) {
                await fs.rename(backupPath, localPath).catch(() => null);
            }
            throw error;
        }
        if (backupPath) {
            await fs.rm(backupPath, { force: true }).catch(() => null);
        }
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
            }
            catch (error) {
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
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    }
    getStats() {
        const activeJobs = this.jobService ? this.jobService.getStats().jobs : this.jobs.size;
        return { ...this.stats, active_connections: this.connections.size, active_jobs: activeJobs };
    }
    async cleanup() {
        for (const entry of this.connections.values()) {
            try {
                entry.client.end();
            }
            catch (error) {
                // ignore cleanup errors
            }
        }
        this.connections.clear();
    }
}
module.exports = SSHManager;
