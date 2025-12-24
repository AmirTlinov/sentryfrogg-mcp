#!/usr/bin/env node

/**
 * 🗝️ Vault client (KV v2 + token auth).
 *
 * Design goals:
 * - No secret leakage in errors/logs by default.
 * - Minimal surface: sys/health, token lookup, KV v2 read.
 * - Testable: injectable fetch implementation.
 */

const { setTimeout: sleepTimeout } = require('timers/promises');

let fetchPromise = null;
async function defaultFetch(...args) {
  if (globalThis.fetch) {
    return globalThis.fetch(...args);
  }
  if (!fetchPromise) {
    fetchPromise = import('node-fetch').then((mod) => mod.default);
  }
  const fetch = await fetchPromise;
  return fetch(...args);
}

function normalizeBaseUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) {
    throw new Error('vault addr is required');
  }
  const url = new URL(value);
  url.hash = '';
  url.search = '';
  // Keep path in case Vault is proxied under a prefix, but normalize trailing slash.
  const normalized = `${url.origin}${url.pathname}`.replace(/\/+$/, '');
  return normalized;
}

function buildHeaders({ token, namespace } = {}) {
  const headers = { Accept: 'application/json' };
  if (namespace) {
    headers['X-Vault-Namespace'] = String(namespace);
  }
  if (token) {
    headers['X-Vault-Token'] = String(token);
  }
  return headers;
}

function parseVaultError(body) {
  if (!body || typeof body !== 'object') {
    return null;
  }
  const errors = body.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    return errors.map((e) => String(e)).join('; ');
  }
  return null;
}

class VaultClient {
  constructor(logger, validation, profileService, options = {}) {
    this.logger = logger.child('vault');
    this.validation = validation;
    this.profileService = profileService;
    this.fetch = options.fetch || defaultFetch;
    this.defaultTimeoutMs = Number.isInteger(options.timeout_ms) ? options.timeout_ms : 15000;
    this.defaultRetries = Number.isInteger(options.retries) ? options.retries : 1;
    this.loginInFlight = new Map();
  }

  async loadProfile(profileName) {
    const name = this.validation.ensureString(profileName, 'profile_name');
    const profile = await this.profileService.getProfile(name, 'vault');
    const data = profile.data || {};
    const secrets = profile.secrets || {};

    const addr = normalizeBaseUrl(data.addr);
    const namespace = data.namespace ? String(data.namespace).trim() : undefined;
    const token = secrets.token ? String(secrets.token) : undefined;
    const auth_type = data.auth_type ? String(data.auth_type).trim().toLowerCase() : undefined;
    const role_id = secrets.role_id ? String(secrets.role_id) : undefined;
    const secret_id = secrets.secret_id ? String(secrets.secret_id) : undefined;

    return { profile_name: name, addr, namespace, token, auth_type, role_id, secret_id };
  }

  async requestJson(url, { method = 'GET', headers, body, timeout_ms, retries } = {}) {
    const timeoutMs = Number.isInteger(timeout_ms) ? timeout_ms : this.defaultTimeoutMs;
    const maxRetries = Number.isInteger(retries) ? retries : this.defaultRetries;

    let attempt = 0;
    // Small retry loop for transient network hiccups; keeps enterprise UX smooth without hiding errors.
    // Retries do not include 4xx statuses.
    while (true) {
      attempt += 1;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await this.fetch(url, {
          method,
          headers,
          body,
          signal: controller.signal,
        });

        const text = await response.text();
        const parsed = text ? JSON.parse(text) : null;

        if (!response.ok) {
          const details = parseVaultError(parsed);
          const message = details
            ? `Vault request failed (${response.status}): ${details}`
            : `Vault request failed (${response.status})`;
          const error = new Error(message);
          error.status = response.status;
          throw error;
        }

        return parsed;
      } catch (error) {
        const isAbort = error && (error.name === 'AbortError' || error.code === 'ABORT_ERR');
        const status = error?.status;
        const retryable = isAbort || (status === undefined && attempt <= maxRetries);
        if (!retryable) {
          throw error;
        }
        await sleepTimeout(150);
      } finally {
        clearTimeout(timer);
      }
    }
  }

  async sysHealth(profileName, options = {}) {
    const profile = await this.loadProfile(profileName);
    const url = `${profile.addr}/v1/sys/health`;
    return this.requestJson(url, {
      method: 'GET',
      headers: buildHeaders({ token: profile.token, namespace: profile.namespace }),
      timeout_ms: options.timeout_ms,
      retries: options.retries,
    });
  }

  async tokenLookupSelf(profileName, options = {}) {
    const profile = await this.loadProfile(profileName);
    const token = await this.ensureToken(profile, { timeout_ms: options.timeout_ms, retries: options.retries });
    const url = `${profile.addr}/v1/auth/token/lookup-self`;
    try {
      return await this.requestJson(url, {
        method: 'GET',
        headers: buildHeaders({ token, namespace: profile.namespace }),
        timeout_ms: options.timeout_ms,
        retries: options.retries,
      });
    } catch (error) {
      if (error?.status === 403 && this.canApprole(profile)) {
        const fresh = await this.loginApprole(profile, { timeout_ms: options.timeout_ms, retries: options.retries });
        return this.requestJson(url, {
          method: 'GET',
          headers: buildHeaders({ token: fresh, namespace: profile.namespace }),
          timeout_ms: options.timeout_ms,
          retries: options.retries,
        });
      }
      throw error;
    }
  }

  canApprole(profile) {
    if (!profile || typeof profile !== 'object') {
      return false;
    }
    const roleId = profile.role_id;
    const secretId = profile.secret_id;
    return typeof roleId === 'string' && roleId.trim().length > 0
      && typeof secretId === 'string' && secretId.trim().length > 0;
  }

  async ensureToken(profile, options = {}) {
    if (profile.token && String(profile.token).trim()) {
      return String(profile.token);
    }
    if (!this.canApprole(profile)) {
      throw new Error('Vault token is required for this operation');
    }
    return this.loginApprole(profile, options);
  }

  async loginApprole(profile, options = {}) {
    const profileName = profile.profile_name;
    if (!profileName) {
      throw new Error('Vault profile_name is required for AppRole login');
    }
    const cached = this.loginInFlight.get(profileName);
    if (cached) {
      return cached;
    }

    const run = (async () => {
      const url = `${profile.addr}/v1/auth/approle/login`;
      const payload = await this.requestJson(url, {
        method: 'POST',
        headers: {
          ...buildHeaders({ namespace: profile.namespace }),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ role_id: String(profile.role_id), secret_id: String(profile.secret_id) }),
        timeout_ms: options.timeout_ms,
        retries: options.retries,
      });

      const token = payload?.auth?.client_token;
      if (!token || typeof token !== 'string' || token.trim().length === 0) {
        throw new Error('Vault AppRole login returned empty client_token');
      }

      await this.profileService.setProfile(profileName, {
        type: 'vault',
        secrets: { token },
      }).catch((error) => {
        this.logger.warn('Failed to persist Vault token after AppRole login', { profile: profileName, error: error.message });
      });

      profile.token = token;
      return token;
    })();

    this.loginInFlight.set(profileName, run);
    run.finally(() => {
      this.loginInFlight.delete(profileName);
    });
    return run;
  }

  parseKv2Ref(ref) {
    const trimmed = String(ref || '').trim();
    // ref format: <mount>/<path>#<key>
    const [pathPart, keyPart] = trimmed.split('#');
    if (!pathPart || !keyPart) {
      throw new Error('vault kv2 ref must be in "<mount>/<path>#<key>" form');
    }
    const parts = pathPart.split('/').filter(Boolean);
    if (parts.length < 2) {
      throw new Error('vault kv2 ref must include mount and path');
    }
    const mount = parts[0];
    const secretPath = parts.slice(1).join('/');
    const key = keyPart.trim();
    if (!key) {
      throw new Error('vault kv2 ref key must be non-empty');
    }
    return { mount, secretPath, key };
  }

  async kv2Get(profileName, ref, options = {}) {
    const profile = await this.loadProfile(profileName);
    const token = await this.ensureToken(profile, { timeout_ms: options.timeout_ms, retries: options.retries });

    const { mount, secretPath, key } = this.parseKv2Ref(ref);

    const url = new URL(`${profile.addr}/v1/${encodeURIComponent(mount)}/data/${secretPath}`);
    if (options.version !== undefined && options.version !== null && options.version !== '') {
      url.searchParams.set('version', String(options.version));
    }

    const fetchOnce = (clientToken) => this.requestJson(url.toString(), {
      method: 'GET',
      headers: buildHeaders({ token: clientToken, namespace: profile.namespace }),
      timeout_ms: options.timeout_ms,
      retries: options.retries,
    });

    let payload;
    try {
      payload = await fetchOnce(token);
    } catch (error) {
      if (error?.status === 403 && this.canApprole(profile)) {
        const fresh = await this.loginApprole(profile, { timeout_ms: options.timeout_ms, retries: options.retries });
        payload = await fetchOnce(fresh);
      } else {
        throw error;
      }
    }

    const data = payload?.data?.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('Vault kv2 response has invalid shape (missing data.data)');
    }

    if (!Object.prototype.hasOwnProperty.call(data, key)) {
      throw new Error(`Vault secret key not found: ${key}`);
    }

    const value = data[key];
    if (value === undefined || value === null) {
      throw new Error(`Vault secret key is null: ${key}`);
    }

    return String(value);
  }
}

module.exports = VaultClient;
