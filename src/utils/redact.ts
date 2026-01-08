#!/usr/bin/env node
// @ts-nocheck

const DEFAULT_REDACTION = '[REDACTED]';
const DEFAULT_MAX_STRING = 500;

const SENSITIVE_KEYS = [
  'password',
  'passphrase',
  'private_key',
  'public_key',
  'secret',
  'token',
  'api_key',
  'auth_token',
  'auth_password',
  'client_secret',
  'refresh_token',
  'header_value',
  'authorization',
  'encryption_key',
];

const SENSITIVE_HEADER_KEYS = [
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'x-auth-token',
  'x-access-token',
];

function normalizeKey(key) {
  return String(key || '').toLowerCase();
}

function isSensitiveKey(key) {
  const normalized = normalizeKey(key);
  if (!normalized) {
    return false;
  }

  if (SENSITIVE_KEYS.includes(normalized)) {
    return true;
  }

  if (normalized.includes('secret') || normalized.includes('token')) {
    return true;
  }

  return false;
}

function truncateString(value, maxLength) {
  if (typeof value !== 'string') {
    return value;
  }
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...`;
}

function redactHeaders(headers, options) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
    return headers;
  }

  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    const normalized = normalizeKey(key);
    if (SENSITIVE_HEADER_KEYS.includes(normalized)) {
      result[key] = options.redaction;
    } else {
      result[key] = truncateString(String(value), options.maxString);
    }
  }
  return result;
}

function redactMapValues(map, options) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) {
    return map;
  }
  const result = {};
  for (const [key] of Object.entries(map)) {
    result[key] = options.redaction;
  }
  return result;
}

function redactObject(value, options = {}, seen = new WeakSet()) {
  const config = {
    redaction: options.redaction || DEFAULT_REDACTION,
    maxString: Number.isFinite(options.maxString) ? options.maxString : DEFAULT_MAX_STRING,
  };

  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    return truncateString(value, config.maxString);
  }

  if (typeof value !== 'object') {
    return value;
  }

  if (Buffer.isBuffer(value)) {
    return `[buffer:${value.length}]`;
  }

  if (seen.has(value)) {
    return '[circular]';
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactObject(item, config, seen));
  }

  const result = {};
  for (const [key, raw] of Object.entries(value)) {
    if (key === 'headers') {
      result[key] = redactHeaders(raw, config);
      continue;
    }

    const normalizedKey = normalizeKey(key);
    if (normalizedKey === 'env' || normalizedKey === 'variables') {
      result[key] = redactMapValues(raw, config);
      continue;
    }

    if (isSensitiveKey(key)) {
      result[key] = config.redaction;
      continue;
    }

    result[key] = redactObject(raw, config, seen);
  }

  return result;
}

module.exports = {
  redactObject,
  isSensitiveKey,
};
