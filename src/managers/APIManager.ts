#!/usr/bin/env node
// @ts-nocheck

/**
 * 🌐 HTTP client for MCP.
 */

const Constants = require('../constants/Constants');
const crypto = require('node:crypto');
const { once } = require('node:events');
const fs = require('fs/promises');
const path = require('path');
const { createWriteStream } = require('fs');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { execFile } = require('child_process');
const { promisify } = require('util');
const http = require('node:http');
const https = require('node:https');
const { getPathValue } = require('../utils/dataPath');
const { isTruthy } = require('../utils/featureFlags');
const { redactText } = require('../utils/redact');
const { unknownActionError } = require('../utils/toolErrors');
const ToolError = require('../errors/ToolError');
const {
  resolveContextRepoRoot,
  buildToolCallFileRef,
  createArtifactWriteStream,
} = require('../utils/artifacts');
const { atomicReplaceFile, ensureDirForFile, pathExists, tempSiblingPath } = require('../utils/fsAtomic');
const { expandHomePath } = require('../utils/userPaths');

const execFileAsync = promisify(execFile);

const DEFAULT_MAX_CAPTURE_BYTES = 256 * 1024;
const API_ACTIONS = [
  'profile_upsert',
  'profile_get',
  'profile_list',
  'profile_delete',
  'request',
  'paginate',
  'download',
  'check',
  'smoke_http',
];

let fetchPromise = null;
async function fetchFn(...args) {
  if (typeof globalThis.fetch === 'function') {
    return globalThis.fetch(...args);
  }
  if (!fetchPromise) {
    fetchPromise = import('node-fetch').then((mod) => mod.default);
  }
  const fetch = await fetchPromise;
  return fetch(...args);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

function resolveStreamToArtifactMode() {
  const raw = process.env.SENTRYFROGG_API_STREAM_TO_ARTIFACT
    || process.env.SF_API_STREAM_TO_ARTIFACT
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

async function readResponseBodyBytes(response, maxCaptureBytes) {
  const limit = Number.isFinite(maxCaptureBytes) && maxCaptureBytes > 0
    ? maxCaptureBytes
    : DEFAULT_MAX_CAPTURE_BYTES;

  const body = response?.body;
  if (body && typeof body[Symbol.asyncIterator] === 'function') {
    const chunks = [];
    let readBytes = 0;
    let captured = 0;
    let truncated = false;

    try {
      for await (const chunk of body) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk ?? '');
        readBytes += buf.length;

        if (captured < limit) {
          const remaining = limit - captured;
          if (buf.length <= remaining) {
            chunks.push(buf);
            captured += buf.length;
          } else {
            chunks.push(buf.subarray(0, remaining));
            captured += remaining;
            truncated = true;
          }
        } else {
          truncated = true;
        }

        if (captured >= limit) {
          truncated = true;
          if (typeof body.destroy === 'function') {
            body.destroy();
          }
          break;
        }
      }
    } catch (error) {
      if (!truncated) {
        throw error;
      }
    }

    const buffer = captured ? Buffer.concat(chunks, captured) : Buffer.alloc(0);
    return {
      buffer,
      body_read_bytes: readBytes,
      body_captured_bytes: buffer.length,
      body_truncated: truncated,
    };
  }

  if (typeof response?.arrayBuffer === 'function') {
    const full = Buffer.from(await response.arrayBuffer());
    const truncated = full.length > limit;
    const buffer = truncated ? full.subarray(0, limit) : full;
    return {
      buffer,
      body_read_bytes: full.length,
      body_captured_bytes: buffer.length,
      body_truncated: truncated,
    };
  }

  if (typeof response?.text === 'function') {
    const text = await response.text();
    const full = Buffer.from(text, 'utf8');
    const truncated = full.length > limit;
    const buffer = truncated ? full.subarray(0, limit) : full;
    return {
      buffer,
      body_read_bytes: full.length,
      body_captured_bytes: buffer.length,
      body_truncated: truncated,
    };
  }

  if (typeof response?.json === 'function') {
    const payload = await response.json();
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const full = Buffer.from(text, 'utf8');
    const truncated = full.length > limit;
    const buffer = truncated ? full.subarray(0, limit) : full;
    return {
      buffer,
      body_read_bytes: full.length,
      body_captured_bytes: buffer.length,
      body_truncated: truncated,
    };
  }

  return {
    buffer: Buffer.alloc(0),
    body_read_bytes: 0,
    body_captured_bytes: 0,
    body_truncated: false,
  };
}

function parseRetryAfter(value) {
  if (!value) {
    return null;
  }
  const trimmed = String(value).trim();
  if (!trimmed) {
    return null;
  }
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const date = Date.parse(trimmed);
  if (!Number.isNaN(date)) {
    return Math.max(0, date - Date.now());
  }
  return null;
}

function parseLinkHeader(header) {
  if (!header) {
    return [];
  }
  return header
    .split(',')
    .map((part) => part.trim())
    .map((part) => {
      const match = part.match(/<([^>]+)>;\s*rel="?([^";]+)"?/i);
      if (!match) {
        return null;
      }
      return { url: match[1], rel: match[2] };
    })
    .filter(Boolean);
}

function toAuthObject(auth) {
  if (auth === undefined || auth === null) {
    return undefined;
  }

  if (typeof auth === 'string') {
    const trimmed = auth.trim();
    if (!trimmed) {
      return undefined;
    }
    if (/^Bearer\s+/i.test(trimmed) || /^Basic\s+/i.test(trimmed)) {
      return { type: 'raw', value: trimmed };
    }
    return { type: 'bearer', token: trimmed };
  }

  if (typeof auth === 'object') {
    return { ...auth };
  }

  return undefined;
}

class APIManager {
  constructor(logger, security, validation, profileService, cacheService, options = {}) {
    this.logger = logger.child('api');
    this.security = security;
    this.validation = validation;
    this.profileService = profileService;
    this.cacheService = cacheService;
    this.projectResolver = options.projectResolver;
    this.secretRefResolver = options.secretRefResolver;
    this.fetch = options.fetch ?? fetchFn;
    this.tokenCache = new Map();
    this.stats = {
      requests: 0,
      errors: 0,
      retries: 0,
      downloads: 0,
      pages: 0,
    };
  }

  resolveMaxCaptureBytes() {
    const fromEnv = readPositiveInt(
      process.env.SENTRYFROGG_API_MAX_CAPTURE_BYTES
      || process.env.SF_API_MAX_CAPTURE_BYTES
      || process.env.SENTRYFROGG_MAX_CAPTURE_BYTES
      || process.env.SF_MAX_CAPTURE_BYTES
    );
    return fromEnv ?? DEFAULT_MAX_CAPTURE_BYTES;
  }

  async handleAction(args) {
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
      case 'request':
        return this.request(args);
      case 'paginate':
        return this.paginate(args);
      case 'download':
        return this.download(args);
      case 'check':
        return this.checkApi(args);
      case 'smoke_http':
        return this.smokeHttp(args);
      default:
        throw unknownActionError({ tool: 'api', action, knownActions: API_ACTIONS });
    }
  }

  splitAuth(auth) {
    const normalized = toAuthObject(auth);
    if (!normalized) {
      return { dataAuth: undefined, secrets: {} };
    }

    const dataAuth = { ...normalized };
    const secrets = {};

    if (dataAuth.token) {
      secrets.auth_token = dataAuth.token;
      delete dataAuth.token;
    }
    if (dataAuth.password) {
      secrets.auth_password = dataAuth.password;
      delete dataAuth.password;
    }
    if (dataAuth.header_value) {
      secrets.auth_header_value = dataAuth.header_value;
      delete dataAuth.header_value;
    }
    if (dataAuth.value) {
      secrets.auth_value = dataAuth.value;
      delete dataAuth.value;
    }

    return { dataAuth, secrets };
  }

  mergeAuth(dataAuth, secrets) {
    if (!dataAuth && (!secrets || Object.keys(secrets).length === 0)) {
      return undefined;
    }

    const auth = { ...(dataAuth || {}) };

    if (secrets?.auth_token) {
      auth.token = secrets.auth_token;
    }
    if (secrets?.auth_password) {
      auth.password = secrets.auth_password;
    }
    if (secrets?.auth_header_value) {
      auth.header_value = secrets.auth_header_value;
    }
    if (secrets?.auth_value) {
      auth.value = secrets.auth_value;
    }

    if (!auth.type) {
      if (auth.value) {
        auth.type = 'raw';
      } else if (auth.token) {
        auth.type = 'bearer';
      } else if (auth.username && auth.password) {
        auth.type = 'basic';
      } else if (auth.header_name && auth.header_value) {
        auth.type = 'header';
      }
    }

    return auth;
  }

  splitAuthProvider(provider) {
    if (!provider) {
      return { dataProvider: undefined, secrets: {} };
    }
    if (typeof provider !== 'object' || Array.isArray(provider)) {
      throw ToolError.invalidParams({ field: 'auth_provider', message: 'auth_provider must be an object' });
    }

    const dataProvider = { ...provider };
    const secrets = {};

    if (dataProvider.client_secret) {
      secrets.auth_provider_client_secret = String(dataProvider.client_secret);
      delete dataProvider.client_secret;
    }
    if (dataProvider.refresh_token) {
      secrets.auth_provider_refresh_token = String(dataProvider.refresh_token);
      delete dataProvider.refresh_token;
    }
    if (dataProvider.exec?.env) {
      secrets.auth_provider_exec_env = JSON.stringify(dataProvider.exec.env);
      dataProvider.exec = { ...dataProvider.exec };
      delete dataProvider.exec.env;
    }

    return { dataProvider, secrets };
  }

  mergeAuthProvider(dataProvider, secrets) {
    if (!dataProvider && (!secrets || Object.keys(secrets).length === 0)) {
      return undefined;
    }

    const provider = { ...(dataProvider || {}) };

    if (secrets?.auth_provider_client_secret) {
      provider.client_secret = secrets.auth_provider_client_secret;
    }
    if (secrets?.auth_provider_refresh_token) {
      provider.refresh_token = secrets.auth_provider_refresh_token;
    }
    if (secrets?.auth_provider_exec_env) {
      try {
        const env = JSON.parse(secrets.auth_provider_exec_env);
        provider.exec = { ...(provider.exec || {}), env };
      } catch (error) {
        provider.exec = { ...(provider.exec || {}) };
      }
    }

    return provider;
  }

  buildAuthHeaders(auth) {
    if (!auth) {
      return {};
    }

    const normalized = toAuthObject(auth);
    if (!normalized || normalized.type === 'none') {
      return {};
    }

    switch (normalized.type) {
      case 'raw':
        return normalized.value ? { Authorization: normalized.value } : {};
      case 'bearer':
        if (!normalized.token) {
          return {};
        }
        return {
          Authorization: normalized.token.startsWith('Bearer ')
            ? normalized.token
            : `Bearer ${normalized.token}`,
        };
      case 'basic': {
        const username = normalized.username ?? '';
        const password = normalized.password ?? '';
        const encoded = Buffer.from(`${username}:${password}`).toString('base64');
        return { Authorization: `Basic ${encoded}` };
      }
      case 'header':
        if (!normalized.header_name || normalized.header_value === undefined) {
          return {};
        }
        return { [normalized.header_name]: normalized.header_value };
      default:
        return {};
    }
  }

  authFromToken(provider, token) {
    const headerName = provider.header_name;
    if (headerName) {
      return { type: 'header', header_name: headerName, header_value: token };
    }

    const scheme = provider.scheme ? String(provider.scheme).toLowerCase() : undefined;
    if (scheme === 'raw') {
      return { type: 'raw', value: token };
    }
    if (scheme === 'basic') {
      return { type: 'raw', value: token };
    }

    return { type: 'bearer', token };
  }

  cacheKey(provider, profileName) {
    const base = provider.cache_key || provider.token_url || provider.command || 'inline';
    return `${profileName || 'inline'}:${base}`;
  }

  getCachedToken(key) {
    const entry = this.tokenCache.get(key);
    if (!entry) {
      return null;
    }
    if (entry.expiresAt && entry.expiresAt <= Date.now()) {
      this.tokenCache.delete(key);
      return null;
    }
    return entry.token;
  }

  setCachedToken(key, token, ttlMs) {
    const expiresAt = ttlMs ? Date.now() + ttlMs : null;
    this.tokenCache.set(key, { token, expiresAt });
  }

  async resolveAuthProvider(provider, profileName, args = {}) {
    if (!provider) {
      return undefined;
    }

    if (this.secretRefResolver) {
      provider = await this.secretRefResolver.resolveDeep(provider, args);
    }

    let type = String(provider.type || '').toLowerCase();
    if (!type) {
      if (provider.command || provider.exec?.command) {
        type = 'exec';
      } else if (provider.token_url) {
        type = 'oauth2';
      }
    }

    if (type === 'static') {
      if (provider.auth) {
        return provider.auth;
      }
      if (provider.token) {
        return { type: 'bearer', token: provider.token };
      }
    }

    if (type === 'exec') {
      const execConfig = provider.exec ? provider.exec : provider;
      const command = execConfig.command;
      if (!command) {
        throw ToolError.invalidParams({
          field: 'auth_provider.exec.command',
          message: 'auth_provider.exec.command is required',
          hint: 'Provide a command that prints a token to stdout (or JSON with token_path).',
        });
      }
      const args = Array.isArray(execConfig.args) ? execConfig.args : [];
      const options = {
        cwd: execConfig.cwd,
        env: execConfig.env,
        timeout: execConfig.timeout_ms,
      };

      const output = await execFileAsync(command, args, options);
      const format = String(execConfig.format || 'raw').toLowerCase();

      let token = (output.stdout || '').trim();
      if (format === 'json') {
        const parsed = JSON.parse(token || '{}');
        const tokenPath = execConfig.token_path || provider.token_path || 'token';
        token = getPathValue(parsed, tokenPath, { required: true });
      }

      if (!token) {
        throw ToolError.invalidParams({
          field: 'auth_provider.exec',
          message: 'auth_provider.exec did not return a token',
          hint: 'Ensure the exec command prints the token (or JSON at token_path) to stdout.',
        });
      }

      return this.authFromToken(execConfig, token);
    }

    if (type === 'oauth2') {
      const tokenUrl = provider.token_url;
      const clientId = provider.client_id;
      const clientSecret = provider.client_secret;

      if (!tokenUrl || !clientId || !clientSecret) {
        throw ToolError.invalidParams({
          field: 'auth_provider',
          message: 'auth_provider.oauth2 requires token_url, client_id, client_secret',
          hint: 'Provide token_url/client_id/client_secret (secrets may be stored in profile secrets).',
        });
      }

      const cacheKey = this.cacheKey(provider, profileName);
      const cached = this.getCachedToken(cacheKey);
      if (cached) {
        return this.authFromToken(provider, cached);
      }

      const grantType = provider.grant_type || 'client_credentials';
      const payload = new URLSearchParams();
      payload.set('grant_type', grantType);
      payload.set('client_id', clientId);
      payload.set('client_secret', clientSecret);

      if (provider.scope) {
        payload.set('scope', provider.scope);
      }
      if (provider.audience) {
        payload.set('audience', provider.audience);
      }
      if (grantType === 'refresh_token') {
        const refreshToken = provider.refresh_token;
        if (!refreshToken) {
          throw ToolError.invalidParams({
            field: 'auth_provider.refresh_token',
            message: 'auth_provider.oauth2.refresh_token is required for refresh_token grant',
          });
        }
        payload.set('refresh_token', refreshToken);
      }
      if (provider.extra && typeof provider.extra === 'object') {
        for (const [key, value] of Object.entries(provider.extra)) {
          payload.set(key, String(value));
        }
      }

      const response = await this.fetch(tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          ...(provider.headers || {}),
        },
        body: payload.toString(),
      });

      if (!response.ok) {
        const text = await response.text();
        const redacted = redactText(String(text || ''), { maxString: 16 * 1024 });
        let error;
        if (response.status === 401 || response.status === 403) {
          error = ToolError.denied({
            code: 'OAUTH2_DENIED',
            message: `OAuth2 token request failed (${response.status})`,
            hint: 'Check client credentials and token_url permissions.',
            details: { status: response.status, body: redacted },
          });
        } else if (response.status === 429 || response.status >= 500) {
          error = ToolError.retryable({
            code: 'OAUTH2_RETRYABLE',
            message: `OAuth2 token request failed (${response.status})`,
            hint: 'Retry later or increase timeout/retries.',
            details: { status: response.status, body: redacted },
          });
        } else {
          error = ToolError.invalidParams({
            field: 'auth_provider',
            message: `OAuth2 token request failed (${response.status})`,
            hint: 'Check token_url/client_id/client_secret and grant_type/scope/audience.',
            details: { status: response.status, body: redacted },
          });
        }
        throw error;
      }

      const tokenPayload = await response.json();
      const tokenPath = provider.token_path || 'access_token';
      const token = getPathValue(tokenPayload, tokenPath, { required: true });
      const expiresIn = Number(tokenPayload.expires_in || provider.expires_in);

      if (token) {
        const ttlMs = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : null;
        if (ttlMs) {
          const bufferMs = provider.expiry_buffer_ms ? Number(provider.expiry_buffer_ms) : 30000;
          this.setCachedToken(cacheKey, token, Math.max(0, ttlMs - bufferMs));
        }
      }

      return this.authFromToken(provider, token);
    }

    return undefined;
  }

  async profileUpsert(profileName, params) {
    const name = this.validation.ensureString(profileName, 'Profile name');
    const base = params.base_url ? String(params.base_url) : undefined;
    const headers = this.validation.ensureHeaders(params.headers);

    const { dataAuth, secrets } = this.splitAuth(params.auth);
    const { dataProvider, secrets: providerSecrets } = this.splitAuthProvider(params.auth_provider);

    await this.profileService.setProfile(name, {
      type: 'api',
      data: {
        base_url: base,
        headers,
        auth: dataAuth,
        auth_provider: dataProvider,
        retry: params.retry,
        pagination: params.pagination,
        cache: params.cache,
        timeout_ms: params.timeout_ms,
        response_type: params.response_type,
        redirect: params.redirect,
      },
      secrets: { ...secrets, ...providerSecrets },
    });

    return { success: true, profile: { name, base_url: base } };
  }

  async profileGet(profileName, includeSecrets = false) {
    const name = this.validation.ensureString(profileName, 'Profile name');
    const profile = await this.profileService.getProfile(name, 'api');

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
    const profiles = await this.profileService.listProfiles('api');
    return { success: true, profiles };
  }

  async profileDelete(profileName) {
    const name = this.validation.ensureString(profileName, 'Profile name');
    await this.profileService.deleteProfile(name);
    return { success: true, profile: name };
  }

  buildHeaders(baseHeaders, authHeaders) {
    return {
      'User-Agent': 'sentryfrogg-api-client/7.0.1',
      Accept: 'application/json, text/plain, */*',
      ...baseHeaders,
      ...authHeaders,
    };
  }

  prepareBody({ body, body_type, body_base64, form }) {
    if (body_base64) {
      return { body: Buffer.from(body_base64, 'base64'), contentType: 'application/octet-stream' };
    }

    if (form && typeof form === 'object') {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(form)) {
        params.append(key, String(value));
      }
      return { body: params.toString(), contentType: 'application/x-www-form-urlencoded' };
    }

    if (body === undefined) {
      return { body: undefined, contentType: undefined };
    }

    const normalizedType = body_type ? String(body_type).toLowerCase() : undefined;

    if (normalizedType === 'json' || (normalizedType === undefined && typeof body === 'object')) {
      return { body: JSON.stringify(body), contentType: 'application/json' };
    }

    if (normalizedType === 'text' || typeof body === 'string') {
      return { body: String(body), contentType: 'text/plain; charset=utf-8' };
    }

    return { body: String(body), contentType: 'text/plain; charset=utf-8' };
  }

  buildUrl(baseUrl, path, query, explicitUrl) {
    let url = explicitUrl;
    if (!url) {
      if (!baseUrl) {
        throw ToolError.invalidParams({
          field: 'base_url',
          message: 'base_url or url must be provided',
          hint: 'Provide args.url for absolute URL, or configure profile.data.base_url and use args.path.',
        });
      }
      try {
        url = path ? new URL(path, baseUrl).toString() : baseUrl;
      } catch (error) {
        throw ToolError.invalidParams({
          field: 'path',
          message: 'Invalid URL/path',
          hint: 'Provide a valid base_url and relative path, or pass a full url.',
        });
      }
    }

    const parsed = this.security.ensureUrl(url);
    if (query && typeof query === 'object') {
      for (const [key, value] of Object.entries(query)) {
        if (Array.isArray(value)) {
          value.forEach((item) => parsed.searchParams.append(key, String(item)));
        } else if (value !== undefined && value !== null) {
          parsed.searchParams.set(key, String(value));
        }
      }
    } else if (typeof query === 'string') {
      parsed.search = query;
    }

    return parsed.toString();
  }

  async resolveProfile(profileName, args = {}) {
    if (!profileName && this.projectResolver) {
      const context = await this.projectResolver.resolveContext(args).catch(() => null);
      const apiProfile = context?.target?.api_profile;
      if (apiProfile) {
        profileName = this.validation.ensureString(String(apiProfile), 'profile_name');
      }
    }

    if (!profileName) {
      const profiles = await this.profileService.listProfiles('api');
      if (profiles.length === 1) {
        profileName = profiles[0].name;
      } else {
        return { name: undefined, data: {}, auth: undefined, authProvider: undefined, retry: undefined, pagination: undefined, secrets: {} };
      }
    }

    const profile = await this.profileService.getProfile(profileName, 'api');
    const data = profile.data || {};
    let auth = this.mergeAuth(data.auth, profile.secrets || {});
    let authProvider = this.mergeAuthProvider(data.auth_provider, profile.secrets || {});

    if (this.secretRefResolver) {
      auth = await this.secretRefResolver.resolveDeep(auth, args);
      authProvider = await this.secretRefResolver.resolveDeep(authProvider, args);
    }

    return {
      name: profileName,
      data,
      auth,
      authProvider,
      retry: data.retry,
      pagination: data.pagination,
      secrets: profile.secrets || {},
    };
  }

  getDefaultRetryPolicy() {
    return {
      enabled: true,
      max_attempts: Constants.RETRY?.MAX_ATTEMPTS ?? 3,
      base_delay_ms: Constants.RETRY?.BASE_DELAY_MS ?? 250,
      max_delay_ms: Constants.RETRY?.MAX_DELAY_MS ?? 5000,
      jitter: Constants.RETRY?.JITTER ?? 0.2,
      status_codes: Constants.RETRY?.STATUS_CODES ?? [408, 429, 500, 502, 503, 504],
      methods: ['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS'],
      retry_on_network_error: true,
      respect_retry_after: true,
      backoff_factor: 2,
    };
  }

  normalizeRetryPolicy(requestPolicy, profilePolicy, method) {
    const fallback = this.getDefaultRetryPolicy();
    const merged = {
      ...fallback,
      ...(profilePolicy || {}),
      ...(requestPolicy || {}),
    };

    if (merged.enabled === false) {
      return { enabled: false };
    }

    const normalizedMethods = Array.isArray(merged.methods)
      ? merged.methods.map((entry) => String(entry).toUpperCase())
      : fallback.methods;

    if (method && !normalizedMethods.includes(String(method).toUpperCase())) {
      return { enabled: false };
    }

    return {
      ...merged,
      methods: normalizedMethods,
      max_attempts: Number(merged.max_attempts) || fallback.max_attempts,
    };
  }

  normalizeCachePolicy(requestCache, profileCache) {
    if (!requestCache && !profileCache) {
      return { enabled: false };
    }

    if (requestCache === false) {
      return { enabled: false };
    }

    const merged = {
      enabled: true,
      ttl_ms: Constants.CACHE?.DEFAULT_TTL_MS ?? 60000,
      cache_errors: false,
      ...(profileCache || {}),
      ...(requestCache === true ? {} : (requestCache || {})),
    };

    if (merged.enabled === false) {
      return { enabled: false };
    }

    return merged;
  }

  buildCacheKey(args, config) {
    if (!this.cacheService) {
      return null;
    }

    return this.cacheService.buildKey({
      url: config.url,
      method: config.method,
      headers: config.headers,
      body: args.body ?? args.data ?? args.form ?? args.body_base64,
    });
  }

  shouldRetryResponse(response, policy) {
    if (!policy.enabled) {
      return false;
    }
    if (!response) {
      return false;
    }
    return Array.isArray(policy.status_codes) && policy.status_codes.includes(response.status);
  }

  computeRetryDelay(attempt, policy, response) {
    const base = Number(policy.base_delay_ms) || 0;
    const factor = Number(policy.backoff_factor) || 2;
    const maxDelay = Number(policy.max_delay_ms) || base;
    const jitter = Number(policy.jitter) || 0;

    let delay = Math.min(maxDelay, base * Math.pow(factor, Math.max(0, attempt - 1)));
    if (jitter > 0) {
      const delta = delay * jitter;
      delay = delay - delta + Math.random() * delta * 2;
    }

    if (policy.respect_retry_after && response) {
      const retryAfter = parseRetryAfter(response.headers?.['retry-after']);
      if (retryAfter !== null && retryAfter > delay) {
        delay = retryAfter;
      }
    }

    return Math.max(0, Math.floor(delay));
  }

  buildRequestConfig(args, profile, auth, overrides = {}) {
    const baseUrl = args.base_url ?? profile.data.base_url;
    const mergedHeaders = {
      ...(profile.data.headers || {}),
      ...this.validation.ensureHeaders(args.headers),
    };

    const authHeaders = this.buildAuthHeaders(auth);
    const finalHeaders = this.buildHeaders(mergedHeaders, authHeaders);

    const { body, contentType } = this.prepareBody({
      body: args.body ?? args.data,
      body_type: args.body_type,
      body_base64: args.body_base64,
      form: args.form,
    });

    if (contentType && !finalHeaders['Content-Type'] && !finalHeaders['content-type']) {
      finalHeaders['Content-Type'] = contentType;
    }

    const url = this.buildUrl(baseUrl, args.path, args.query, args.url);
    const method = String(args.method || 'GET').toUpperCase();
    const timeoutMs = args.timeout_ms ?? profile.data.timeout_ms ?? Constants.NETWORK.TIMEOUT_API_REQUEST;

    const config = {
      url,
      method,
      headers: finalHeaders,
      body,
      timeoutMs,
      redirect: args.redirect ?? profile.data.redirect ?? 'follow',
    };

    if (overrides.headers) {
      config.headers = { ...config.headers, ...overrides.headers };
    }
    if (overrides.url) {
      config.url = overrides.url;
    }
    if (overrides.method) {
      config.method = overrides.method;
    }
    if (overrides.body !== undefined) {
      config.body = overrides.body;
    }
    if (overrides.timeoutMs !== undefined) {
      config.timeoutMs = overrides.timeoutMs;
    }
    if (overrides.redirect) {
      config.redirect = overrides.redirect;
    }
    if (overrides.duplex) {
      config.duplex = overrides.duplex;
    }

    return config;
  }

  async requestOnce(args, profile, auth) {
    const config = this.buildRequestConfig(args, profile, auth);
    const controller = new AbortController();
    const timeout = config.timeoutMs ? setTimeout(() => controller.abort(), config.timeoutMs) : null;
    const started = Date.now();

    try {
      const response = await this.fetch(config.url, {
        method: config.method,
        headers: config.headers,
        body: config.body,
        signal: controller.signal,
        redirect: config.redirect,
      });

      const contentType = response.headers.get('content-type') || '';
      const responseType = (args.response_type || profile.data.response_type || 'auto').toLowerCase();

      const maxCaptureBytes = this.resolveMaxCaptureBytes();
      const streamMode = resolveStreamToArtifactMode();
      const contextRoot = streamMode ? resolveContextRepoRoot() : null;
      const traceId = args.trace_id || 'run';
      const spanId = args.span_id || crypto.randomUUID();

      let bodyRef = null;
      let bodyRefTruncated = null;
      let body;

      if (
        streamMode
        && contextRoot
        && response?.body
        && typeof response.body[Symbol.asyncIterator] === 'function'
      ) {
        const artifactLimit = streamMode === 'full' ? Number.POSITIVE_INFINITY : maxCaptureBytes;
        const previewChunks = [];
        let previewCaptured = 0;
        let previewTruncated = false;
        let readBytes = 0;
        let artifactWritten = 0;
        let artifactTruncated = false;

        const filename = `api-body-${crypto.randomUUID()}.bin`;
        const ref = buildToolCallFileRef({ traceId, spanId, filename });

        let writer = null;
        try {
          writer = await createArtifactWriteStream(contextRoot, ref);
        } catch (artifactError) {
          this.logger.warn('Failed to initialize API response artifact stream', { error: artifactError.message });
        }

        if (writer) {
          let abortedEarly = false;
          try {
            for await (const chunk of response.body) {
              const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk ?? '');
              readBytes += buf.length;

              if (previewCaptured < maxCaptureBytes) {
                const remaining = maxCaptureBytes - previewCaptured;
                if (buf.length <= remaining) {
                  previewChunks.push(buf);
                  previewCaptured += buf.length;
                } else {
                  previewChunks.push(buf.subarray(0, remaining));
                  previewCaptured += remaining;
                  previewTruncated = true;
                }
              } else {
                previewTruncated = true;
              }

              if (artifactWritten < artifactLimit && writer) {
                const remaining = artifactLimit - artifactWritten;
                const slice = buf.length <= remaining ? buf : buf.subarray(0, remaining);
                try {
                  const ok = writer.stream.write(slice);
                  if (!ok) {
                    await once(writer.stream, 'drain');
                  }
                } catch (writeError) {
                  this.logger.warn('Failed to stream API response body chunk', { error: writeError.message });
                  await writer.abort().catch(() => null);
                  writer = null;
                }
                artifactWritten += slice.length;
                if (slice.length < buf.length) {
                  artifactTruncated = true;
                }
              } else if (artifactLimit !== Number.POSITIVE_INFINITY) {
                artifactTruncated = true;
              }

              if (artifactLimit !== Number.POSITIVE_INFINITY && artifactWritten >= artifactLimit) {
                previewTruncated = true;
                abortedEarly = true;
                if (typeof response.body.destroy === 'function') {
                  response.body.destroy();
                }
                break;
              }
            }
          } catch (error) {
            if (!abortedEarly) {
              await writer.abort().catch(() => null);
              throw error;
            }
          }

          const previewBuffer = previewCaptured
            ? Buffer.concat(previewChunks, previewCaptured)
            : Buffer.alloc(0);

          if (writer && artifactWritten > 0) {
            try {
              const written = await writer.finalize();
              bodyRef = { uri: written.uri, rel: written.rel, bytes: written.bytes };
              bodyRefTruncated = artifactTruncated;
            } catch (artifactError) {
              this.logger.warn('Failed to finalize API response artifact', { error: artifactError.message });
              await writer.abort().catch(() => null);
            }
          } else if (writer) {
            await writer.abort().catch(() => null);
          }

          body = {
            buffer: previewBuffer,
            body_read_bytes: readBytes,
            body_captured_bytes: previewBuffer.length,
            body_truncated: previewTruncated,
          };
        } else {
          body = await readResponseBodyBytes(response, maxCaptureBytes);
        }
      } else {
        body = await readResponseBodyBytes(response, maxCaptureBytes);
      }

      let data;
      let bodyBase64;
      let bodyBytes;
      let dataTruncated;

      if (responseType === 'bytes') {
        bodyBase64 = body.buffer.toString('base64');
        bodyBytes = body.buffer.length;
      } else if (responseType === 'text') {
        data = body.buffer.toString('utf8');
        dataTruncated = body.body_truncated;
      } else if (responseType === 'json' || contentType.includes('application/json')) {
        const text = body.buffer.toString('utf8');
        if (!body.body_truncated) {
          try {
            data = JSON.parse(text);
          } catch (error) {
            data = text;
          }
        } else {
          data = text;
        }
        dataTruncated = body.body_truncated;
      } else {
        data = body.buffer.toString('utf8');
        dataTruncated = body.body_truncated;
      }

      this.stats.requests += 1;

      return {
        success: response.ok,
        method: config.method,
        url: config.url,
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        duration_ms: Date.now() - started,
        data,
        data_truncated: dataTruncated,
        body_base64: bodyBase64,
        body_bytes: bodyBytes,
        body_read_bytes: body.body_read_bytes,
        body_captured_bytes: body.body_captured_bytes,
        body_truncated: body.body_truncated,
        body_ref: bodyRef,
        body_ref_truncated: bodyRefTruncated,
      };
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  async fetchOnce(args, profile, auth, overrides = {}) {
    const config = this.buildRequestConfig(args, profile, auth, overrides);
    const controller = new AbortController();
    const timeout = config.timeoutMs ? setTimeout(() => controller.abort(), config.timeoutMs) : null;
    const started = Date.now();

    try {
      const response = await this.fetch(config.url, {
        method: config.method,
        headers: config.headers,
        body: config.body,
        signal: controller.signal,
        redirect: config.redirect,
        duplex: config.duplex,
      });

      return { response, config, duration_ms: Date.now() - started };
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  async fetchWithRetry(args, profile, auth, overrides = {}) {
    const policy = this.normalizeRetryPolicy(args.retry, profile.retry, args.method);
    if (!policy.enabled) {
      const once = await this.fetchOnce(args, profile, auth, overrides);
      return { ...once, attempts: 1, retries: 0 };
    }

    let attempt = 0;
    let lastError = null;
    let lastResponse = null;

    while (attempt < policy.max_attempts) {
      attempt += 1;
      try {
        const once = await this.fetchOnce(args, profile, auth, overrides);
        lastResponse = once;

        const headers = Object.fromEntries(once.response.headers.entries());
        const summary = {
          status: once.response.status,
          headers,
        };

        if (!this.shouldRetryResponse(summary, policy) || attempt >= policy.max_attempts) {
          return {
            ...once,
            attempts: attempt,
            retries: Math.max(0, attempt - 1),
          };
        }

        this.stats.retries += 1;
        const delay = this.computeRetryDelay(attempt, policy, summary);
        await sleep(delay);
      } catch (error) {
        lastError = error;
        if (!policy.retry_on_network_error || attempt >= policy.max_attempts) {
          throw error;
        }
        this.stats.retries += 1;
        const delay = this.computeRetryDelay(attempt, policy);
        await sleep(delay);
      }
    }

    if (lastResponse) {
      return lastResponse;
    }

    if (ToolError.isToolError(lastError)) {
      throw lastError;
    }
    const isAbort = lastError && (lastError.name === 'AbortError' || lastError.code === 'ABORT_ERR' || lastError.message === 'timeout');
    if (isAbort) {
      throw ToolError.timeout({
        code: 'HTTP_TIMEOUT',
        message: 'Request timed out',
        hint: 'Increase timeout_ms, or reduce response size.',
      });
    }
    throw ToolError.retryable({
      code: 'HTTP_RETRY_EXHAUSTED',
      message: 'Request failed after retries',
      hint: 'Check network/endpoint, or increase retry.max_attempts.',
      details: { last_error: lastError?.message || String(lastError || '') },
    });
  }

  async requestWithRetry(args, profile, auth) {
    const policy = this.normalizeRetryPolicy(args.retry, profile.retry, args.method);
    if (!policy.enabled) {
      return this.requestOnce(args, profile, auth);
    }

    let attempt = 0;
    let lastResponse = null;
    let lastError = null;

    while (attempt < policy.max_attempts) {
      attempt += 1;
      try {
        const response = await this.requestOnce(args, profile, auth);
        lastResponse = response;
        if (!this.shouldRetryResponse(response, policy) || attempt >= policy.max_attempts) {
          return {
            ...response,
            attempts: attempt,
            retries: Math.max(0, attempt - 1),
          };
        }

        this.stats.retries += 1;
        const delay = this.computeRetryDelay(attempt, policy, response);
        await sleep(delay);
      } catch (error) {
        lastError = error;
        if (!policy.retry_on_network_error || attempt >= policy.max_attempts) {
          throw error;
        }
        this.stats.retries += 1;
        const delay = this.computeRetryDelay(attempt, policy);
        await sleep(delay);
      }
    }

    if (lastResponse) {
      return lastResponse;
    }

    if (ToolError.isToolError(lastError)) {
      throw lastError;
    }
    const isAbort = lastError && (lastError.name === 'AbortError' || lastError.code === 'ABORT_ERR' || lastError.message === 'timeout');
    if (isAbort) {
      throw ToolError.timeout({
        code: 'HTTP_TIMEOUT',
        message: 'Request timed out',
        hint: 'Increase timeout_ms, or reduce response size.',
      });
    }
    throw ToolError.retryable({
      code: 'HTTP_RETRY_EXHAUSTED',
      message: 'Request failed after retries',
      hint: 'Check network/endpoint, or increase retry.max_attempts.',
      details: { last_error: lastError?.message || String(lastError || '') },
    });
  }

  normalizePagination(requestPagination, profilePagination) {
    const merged = {
      ...(profilePagination || {}),
      ...(requestPagination || {}),
    };
    if (!merged || !merged.type) {
      throw ToolError.invalidParams({ field: 'pagination.type', message: 'pagination.type is required' });
    }

    return {
      type: String(merged.type).toLowerCase(),
      param: merged.param || merged.cursor_param || 'page',
      size_param: merged.size_param || 'limit',
      size: merged.size ?? merged.page_size ?? Constants.PAGINATION?.PAGE_SIZE ?? 100,
      start: merged.start ?? (merged.type === 'page' ? 1 : 0),
      max_pages: merged.max_pages ?? Constants.PAGINATION?.MAX_PAGES ?? 10,
      item_path: merged.item_path,
      cursor_path: merged.cursor_path,
      link_rel: merged.link_rel || 'next',
      stop_on_empty: merged.stop_on_empty !== false,
    };
  }

  async request(args) {
    const profile = await this.resolveProfile(args.profile_name, args);
    let auth = args.auth !== undefined ? args.auth : profile.auth;
    const authProvider = args.auth_provider !== undefined ? args.auth_provider : profile.authProvider;

    if (authProvider) {
      auth = await this.resolveAuthProvider(authProvider, profile.name, args);
    }

    try {
      const cachePolicy = this.normalizeCachePolicy(args.cache, profile.data.cache);
      let cacheKey = null;

      if (cachePolicy.enabled && this.cacheService) {
        const config = this.buildRequestConfig(args, profile, auth);
        const explicitKey = cachePolicy.key !== undefined ? this.cacheService.normalizeKey(cachePolicy.key) : null;
        cacheKey = explicitKey || this.buildCacheKey(args, config);
        if (cacheKey) {
          const cached = await this.cacheService.getJson(cacheKey, cachePolicy.ttl_ms);
          if (cached?.value) {
            const createdAt = cached.created_at ? Date.parse(cached.created_at) : null;
            const ageMs = createdAt ? Date.now() - createdAt : null;
            return {
              ...cached.value,
              cache: { hit: true, key: cacheKey, created_at: cached.created_at, age_ms: ageMs },
            };
          }
        }
      }

      const response = await this.requestWithRetry(args, profile, auth);

      if (cachePolicy.enabled && this.cacheService && cacheKey) {
        if (response.success !== false || cachePolicy.cache_errors) {
          await this.cacheService.setJson(cacheKey, response, {
            ttl_ms: cachePolicy.ttl_ms,
            meta: { url: response.url, method: response.method },
          });
        }
        response.cache = { hit: false, key: cacheKey };
      }

      return response;
    } catch (error) {
      this.stats.errors += 1;
      this.logger.error('HTTP request failed', { method: args.method, url: args.url, error: error.message });
      throw error;
    }
  }

  async paginate(args) {
    const profile = await this.resolveProfile(args.profile_name, args);
    let auth = args.auth !== undefined ? args.auth : profile.auth;
    const authProvider = args.auth_provider !== undefined ? args.auth_provider : profile.authProvider;

    if (authProvider) {
      auth = await this.resolveAuthProvider(authProvider, profile.name, args);
    }

    const pagination = this.normalizePagination(args.pagination, profile.pagination);
    const pages = [];
    const items = [];

    let cursor = pagination.start;
    let pageNumber = pagination.start;
    let offset = pagination.start;
    let nextUrl = args.url;

    for (let page = 0; page < pagination.max_pages; page += 1) {
      const requestArgs = { ...args };
      delete requestArgs.pagination;

      if (pagination.type === 'page') {
        requestArgs.query = { ...(args.query || {}), [pagination.param]: pageNumber, [pagination.size_param]: pagination.size };
      } else if (pagination.type === 'offset') {
        requestArgs.query = { ...(args.query || {}), [pagination.param]: offset, [pagination.size_param]: pagination.size };
      } else if (pagination.type === 'cursor') {
        const query = { ...(args.query || {}) };
        if (cursor !== undefined && cursor !== null && cursor !== '') {
          query[pagination.param] = cursor;
        }
        if (pagination.size_param) {
          query[pagination.size_param] = pagination.size;
        }
        requestArgs.query = query;
      } else if (pagination.type === 'link') {
        if (!nextUrl) {
          break;
        }
        requestArgs.url = nextUrl;
        requestArgs.path = undefined;
        requestArgs.base_url = undefined;
      }

      const response = await this.requestWithRetry(requestArgs, profile, auth);
      pages.push(response);
      this.stats.pages += 1;

      if (pagination.item_path) {
        const pageItems = getPathValue(response, pagination.item_path, { defaultValue: [] });
        if (Array.isArray(pageItems)) {
          items.push(...pageItems);
          if (pagination.stop_on_empty && pageItems.length === 0) {
            break;
          }
        } else if (pagination.stop_on_empty) {
          break;
        }
      }

      if (pagination.type === 'page') {
        pageNumber += 1;
      } else if (pagination.type === 'offset') {
        offset += pagination.size;
      } else if (pagination.type === 'cursor') {
        if (!pagination.cursor_path) {
          throw ToolError.invalidParams({
            field: 'pagination.cursor_path',
            message: 'pagination.cursor_path is required for cursor pagination',
            hint: 'Provide pagination.cursor_path (JSON path to next cursor), or use pagination.type=page/offset/link.',
          });
        }
        const nextCursor = getPathValue(response, pagination.cursor_path, { defaultValue: null });
        if (!nextCursor) {
          cursor = null;
          break;
        }
        cursor = nextCursor;
      } else if (pagination.type === 'link') {
        const header = response.headers?.link || response.headers?.Link || response.headers?.LINK;
        const links = parseLinkHeader(header);
        const next = links.find((link) => link.rel === pagination.link_rel);
        if (!next) {
          nextUrl = null;
          break;
        }
        nextUrl = next.url;
      }
    }

    return {
      success: pages.every((page) => page.success !== false),
      pages,
      items: pagination.item_path ? items : undefined,
      page_count: pages.length,
      next_cursor: cursor,
    };
  }

  async downloadOnce(args, profile, auth) {
    const config = this.buildRequestConfig(args, profile, auth);
    const filePath = expandHomePath(args.download_path || args.file_path);
    if (!filePath) {
      throw ToolError.invalidParams({
        field: 'download_path',
        message: 'download_path is required',
        hint: 'Provide args.download_path (or args.file_path) as a local filesystem path.',
      });
    }

    const overwrite = args.overwrite === true;
    if (!overwrite && await pathExists(filePath)) {
      throw ToolError.conflict({
        code: 'LOCAL_PATH_EXISTS',
        message: `Local path already exists: ${filePath}`,
        hint: 'Set overwrite=true to replace it.',
        details: { path: filePath },
      });
    }

    const controller = new AbortController();
    const timeout = config.timeoutMs ? setTimeout(() => controller.abort(), config.timeoutMs) : null;
    const started = Date.now();
    const tmpPath = tempSiblingPath(filePath, '.part');

    try {
      await ensureDirForFile(filePath);
      const response = await this.fetch(config.url, {
        method: config.method,
        headers: config.headers,
        body: config.body,
        signal: controller.signal,
        redirect: config.redirect,
      });

      if (response.body) {
        const readable = Readable.fromWeb(response.body);
        await pipeline(readable, createWriteStream(tmpPath, { mode: 0o600 }));
      } else {
        const buffer = Buffer.from(await response.arrayBuffer());
        await fs.writeFile(tmpPath, buffer, { mode: 0o600 });
      }

      await atomicReplaceFile(tmpPath, filePath, { overwrite, mode: 0o600 });
      const stat = await fs.stat(filePath);

      this.stats.downloads += 1;
      return {
        success: response.ok,
        method: config.method,
        url: config.url,
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        file_path: filePath,
        bytes: stat.size,
        duration_ms: Date.now() - started,
      };
    } catch (error) {
      try {
        await fs.unlink(tmpPath);
      } catch (cleanupError) {
        // ignore cleanup errors
      }
      throw error;
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  async download(args) {
    const profile = await this.resolveProfile(args.profile_name, args);
    let auth = args.auth !== undefined ? args.auth : profile.auth;
    const authProvider = args.auth_provider !== undefined ? args.auth_provider : profile.authProvider;

    if (authProvider) {
      auth = await this.resolveAuthProvider(authProvider, profile.name, args);
    }

    const policy = this.normalizeRetryPolicy(args.retry, profile.retry, args.method);
    if (!policy.enabled) {
      return this.downloadOnce(args, profile, auth);
    }

    let attempt = 0;
    let lastResponse = null;
    let lastError = null;

    while (attempt < policy.max_attempts) {
      attempt += 1;
      try {
        const response = await this.downloadOnce(args, profile, auth);
        lastResponse = response;
        if (!this.shouldRetryResponse(response, policy) || attempt >= policy.max_attempts) {
          return {
            ...response,
            attempts: attempt,
            retries: Math.max(0, attempt - 1),
          };
        }

        this.stats.retries += 1;
        const delay = this.computeRetryDelay(attempt, policy, response);
        await sleep(delay);
      } catch (error) {
        lastError = error;
        if (!policy.retry_on_network_error || attempt >= policy.max_attempts) {
          throw error;
        }
        this.stats.retries += 1;
        const delay = this.computeRetryDelay(attempt, policy);
        await sleep(delay);
      }
    }

    if (lastResponse) {
      return lastResponse;
    }

    if (ToolError.isToolError(lastError)) {
      throw lastError;
    }
    const isAbort = lastError && (lastError.name === 'AbortError' || lastError.code === 'ABORT_ERR' || lastError.message === 'timeout');
    if (isAbort) {
      throw ToolError.timeout({
        code: 'HTTP_TIMEOUT',
        message: 'Download timed out',
        hint: 'Increase timeout_ms, or reduce response size.',
      });
    }
    throw ToolError.retryable({
      code: 'HTTP_RETRY_EXHAUSTED',
      message: 'Download failed after retries',
      hint: 'Check network/endpoint, or increase retry.max_attempts.',
      details: { last_error: lastError?.message || String(lastError || '') },
    });
  }

  async checkApi(args = {}) {
    try {
      const result = await this.request({ ...args, method: 'GET' });
      return {
        success: true,
        accessible: result.status < 500,
        status: result.status,
        response: result.data ?? result.body_base64,
      };
    } catch (error) {
      return {
        success: false,
        accessible: false,
        error: error.message,
      };
    }
  }

  async smokeHttp(args = {}) {
    const rawUrl = this.validation.ensureString(args.url, 'url');
    const expectCode = Number.isFinite(Number(args.expect_code)) ? Math.floor(Number(args.expect_code)) : 200;
    const followRedirects = args.follow_redirects !== false;
    const insecureOk = args.insecure_ok !== false;
    const maxBytes = Math.min(readPositiveInt(args.max_bytes) ?? 32 * 1024, 256 * 1024);
    const timeoutMs = Math.min(readPositiveInt(args.timeout_ms) ?? 10000, 120000);

    const started = Date.now();

    let url;
    try {
      const parsed = this.security?.ensureUrl ? this.security.ensureUrl(rawUrl) : new URL(rawUrl);
      if (parsed.username || parsed.password) {
        throw ToolError.invalidParams({ field: 'url', message: 'URL must not include credentials' });
      }
      url = parsed.toString();
    } catch (error) {
      return {
        success: false,
        url: rawUrl,
        expect_code: expectCode,
        error: error?.message || String(error),
        duration_ms: Date.now() - started,
      };
    }

    const MAX_REDIRECTS = 10;
    const captureLimit = Math.min(maxBytes + 1, 256 * 1024 + 1);

    const requestOnce = (targetUrl, remainingMs) => new Promise((resolve, reject) => {
      const parsed = new URL(targetUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        reject(new Error(`Unsupported URL protocol: ${parsed.protocol}`));
        return;
      }

      const isHttps = parsed.protocol === 'https:';
      const lib = isHttps ? https : http;
      const headers = {
        accept: '*/*',
        'accept-encoding': 'identity',
        connection: 'close',
      };

      const req = lib.request(parsed, {
        method: 'GET',
        headers,
        ...(isHttps && insecureOk ? { rejectUnauthorized: false } : {}),
      }, (res) => {
        const status = Number.isFinite(res.statusCode) ? res.statusCode : 0;
        const location = Array.isArray(res.headers?.location)
          ? res.headers.location[0]
          : res.headers?.location;

        const chunks = [];
        let captured = 0;
        let bytes = 0;
        let truncated = false;
        let settled = false;

        const finalize = () => {
          if (settled) {
            return;
          }
          settled = true;
          const buffer = captured ? Buffer.concat(chunks, captured) : Buffer.alloc(0);
          resolve({
            status,
            location: location ? String(location) : null,
            bytes,
            buffer,
            truncated,
          });
        };

        res.on('data', (chunk) => {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk ?? '');
          bytes += buf.length;
          if (captured < captureLimit) {
            const remaining = captureLimit - captured;
            if (buf.length <= remaining) {
              chunks.push(buf);
              captured += buf.length;
            } else {
              chunks.push(buf.subarray(0, remaining));
              captured += remaining;
              truncated = true;
              res.destroy();
            }
          } else {
            truncated = true;
            res.destroy();
          }

          if (captured >= captureLimit) {
            truncated = true;
            res.destroy();
          }
        });

        res.once('end', finalize);
        res.once('close', finalize);
      });

      req.setTimeout(remainingMs, () => {
        req.destroy(new Error('timeout'));
      });

      req.on('error', (err) => {
        reject(err);
      });

      req.end();
    });

    let currentUrl = url;
    let finalUrl = currentUrl;
    let redirected = false;
    let status = 0;
    let bytes = 0;
    let captured = Buffer.alloc(0);
    let truncated = false;

    try {
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const remainingMs = timeoutMs - (Date.now() - started);
        if (remainingMs <= 0) {
          throw ToolError.timeout({ code: 'HTTP_TIMEOUT', message: 'timeout' });
        }

        const result = await requestOnce(currentUrl, remainingMs);
        status = result.status;
        bytes = result.bytes;
        captured = result.buffer;
        truncated = result.truncated;
        finalUrl = currentUrl;

        const location = result.location;
        const isRedirect = location && [301, 302, 303, 307, 308].includes(status);
        if (followRedirects && isRedirect) {
          if (hop >= MAX_REDIRECTS) {
            throw ToolError.invalidParams({
              field: 'follow_redirects',
              message: `Too many redirects (>${MAX_REDIRECTS})`,
              hint: 'Disable follow_redirects or fix the redirect chain.',
            });
          }
          const next = new URL(location, currentUrl);
          if (next.protocol !== 'http:' && next.protocol !== 'https:') {
            throw ToolError.invalidParams({
              field: 'url',
              message: `Redirected to unsupported protocol: ${next.protocol}`,
            });
          }
          const ensured = this.security?.ensureUrl ? this.security.ensureUrl(next.toString()) : next;
          if (ensured.username || ensured.password) {
            throw ToolError.invalidParams({ field: 'url', message: 'Redirect URL must not include credentials' });
          }
          currentUrl = ensured.toString();
          finalUrl = currentUrl;
          redirected = true;
          continue;
        }

        break;
      }
    } catch (error) {
      return {
        success: false,
        url,
        final_url: finalUrl,
        expect_code: expectCode,
        status,
        error: error?.message || String(error),
        duration_ms: Date.now() - started,
      };
    }

    const previewBuffer = captured.length > maxBytes ? captured.subarray(0, maxBytes) : captured;
    const outTruncated = truncated || captured.length > maxBytes;
    const bodyText = redactText(previewBuffer.toString('utf8'), { maxString: Number.POSITIVE_INFINITY });
    return {
      success: true,
      ok: status === expectCode,
      url,
      final_url: finalUrl,
      redirected,
      insecure_ok: insecureOk,
      follow_redirects: followRedirects,
      expect_code: expectCode,
      status,
      duration_ms: Date.now() - started,
      bytes,
      captured_bytes: previewBuffer.length,
      truncated: outTruncated,
      body_preview: bodyText,
    };
  }

  getStats() {
    return { ...this.stats };
  }

  async cleanup() {
    // нет ресурсов для очистки
  }
}

module.exports = APIManager;
