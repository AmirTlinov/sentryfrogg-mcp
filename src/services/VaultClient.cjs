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
  }

  async loadProfile(profileName) {
    const name = this.validation.ensureString(profileName, 'profile_name');
    const profile = await this.profileService.getProfile(name, 'vault');
    const data = profile.data || {};
    const secrets = profile.secrets || {};

    const addr = normalizeBaseUrl(data.addr);
    const namespace = data.namespace ? String(data.namespace).trim() : undefined;
    const token = secrets.token ? String(secrets.token) : undefined;

    return { profile_name: name, addr, namespace, token };
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
    if (!profile.token) {
      throw new Error('Vault token is required for token lookup');
    }
    const url = `${profile.addr}/v1/auth/token/lookup-self`;
    return this.requestJson(url, {
      method: 'GET',
      headers: buildHeaders({ token: profile.token, namespace: profile.namespace }),
      timeout_ms: options.timeout_ms,
      retries: options.retries,
    });
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
    if (!profile.token) {
      throw new Error('Vault token is required for kv2 get');
    }

    const { mount, secretPath, key } = this.parseKv2Ref(ref);

    const url = new URL(`${profile.addr}/v1/${encodeURIComponent(mount)}/data/${secretPath}`);
    if (options.version !== undefined && options.version !== null && options.version !== '') {
      url.searchParams.set('version', String(options.version));
    }

    const payload = await this.requestJson(url.toString(), {
      method: 'GET',
      headers: buildHeaders({ token: profile.token, namespace: profile.namespace }),
      timeout_ms: options.timeout_ms,
      retries: options.retries,
    });

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

