#!/usr/bin/env node
"use strict";
// @ts-nocheck
Object.defineProperty(exports, "__esModule", { value: true });
const DEFAULT_REDACTION = '[REDACTED]';
const DEFAULT_MAX_STRING = 500;
const INLINE_REDACTION = '***REDACTED***';
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
    if (maxLength === Number.POSITIVE_INFINITY) {
        return value;
    }
    if (!Number.isFinite(maxLength) || maxLength <= 0) {
        return '';
    }
    if (value.length <= maxLength) {
        return value;
    }
    return `${value.slice(0, maxLength)}...`;
}
function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function redactInlineSecrets(value, options) {
    if (typeof value !== 'string' || !value) {
        return value;
    }
    let out = value;
    // OpenAI-style API keys (covers sk-..., including sk-proj-...).
    out = out.replace(/\bsk-proj-[A-Za-z0-9_-]{10,}\b/g, `sk-proj-${INLINE_REDACTION}`);
    out = out.replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, `sk-${INLINE_REDACTION}`);
    // GitHub tokens.
    out = out.replace(/\bghp_[A-Za-z0-9]{20,}\b/g, `ghp_${INLINE_REDACTION}`);
    out = out.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, `github_pat_${INLINE_REDACTION}`);
    // GitLab tokens.
    out = out.replace(/\bglpat-[A-Za-z0-9_-]{10,}\b/g, `glpat-${INLINE_REDACTION}`);
    // Slack tokens.
    out = out.replace(/\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g, INLINE_REDACTION);
    // Google API keys.
    out = out.replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, `AIza${INLINE_REDACTION}`);
    // JWTs (base64url triples).
    out = out.replace(/\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/g, INLINE_REDACTION);
    // Authorization bearer tokens.
    out = out.replace(/\b(Bearer)\s+([A-Za-z0-9._~-]{10,})\b/gi, `$1 ${INLINE_REDACTION}`);
    // AWS access key ids.
    out = out.replace(/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, (match) => `${match.slice(0, 4)}${INLINE_REDACTION}`);
    // Common key=value leaks.
    out = out.replace(/\b(password|passwd|passphrase|token|api[_-]?key|secret|access[_-]?token|refresh[_-]?token)\b\s*([:=])\s*([^\s"'`]+)/gi, (_match, key, sep) => `${key}${sep}${INLINE_REDACTION}`);
    // PEM private keys.
    out = out.replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, `-----BEGIN PRIVATE KEY-----\n${INLINE_REDACTION}\n-----END PRIVATE KEY-----`);
    const extras = Array.isArray(options?.extraSecretValues) ? options.extraSecretValues : [];
    for (const raw of extras) {
        if (typeof raw !== 'string') {
            continue;
        }
        const needle = raw.trim();
        if (needle.length < 6) {
            continue;
        }
        out = out.replace(new RegExp(escapeRegExp(needle), 'g'), INLINE_REDACTION);
    }
    return out;
}
function redactText(value, options = {}) {
    const maxString = Object.prototype.hasOwnProperty.call(options, 'maxString')
        ? options.maxString
        : Number.POSITIVE_INFINITY;
    const config = {
        maxString,
        extraSecretValues: Array.isArray(options.extraSecretValues) ? options.extraSecretValues : null,
    };
    const redacted = redactInlineSecrets(String(value ?? ''), config);
    return truncateString(redacted, config.maxString);
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
        }
        else {
            result[key] = redactText(String(value), options);
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
        extraSecretValues: Array.isArray(options.extraSecretValues) ? options.extraSecretValues : null,
    };
    if (value === null || value === undefined) {
        return value;
    }
    if (typeof value === 'string') {
        return redactText(value, config);
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
    redactText,
    isSensitiveKey,
};
