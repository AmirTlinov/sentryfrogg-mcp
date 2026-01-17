#!/usr/bin/env node
"use strict";
// @ts-nocheck
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * 🔐 Упрощённая система безопасности.
 */
const crypto = require('crypto');
const fs = require('fs');
const Constants = require('../constants/Constants');
const { resolveProfileKeyPath } = require('../utils/paths');
const ToolError = require('../errors/ToolError');
const KEY_BYTES = Constants.BUFFERS.CRYPTO_KEY_SIZE;
const IV_BYTES = Constants.BUFFERS.CRYPTO_IV_SIZE;
const TAG_BYTES = Constants.BUFFERS.CRYPTO_TAG_SIZE;
function decodeKey(raw) {
    if (!raw) {
        return null;
    }
    const trimmed = raw.trim();
    if (trimmed.length === KEY_BYTES * 2) {
        return Buffer.from(trimmed, 'hex');
    }
    if (trimmed.length === KEY_BYTES) {
        return Buffer.from(trimmed, 'utf8');
    }
    if (trimmed.length > KEY_BYTES * 2) {
        try {
            return Buffer.from(trimmed, 'base64');
        }
        catch (error) {
            return null;
        }
    }
    return null;
}
class Security {
    constructor(logger) {
        this.logger = logger.child('security');
        this.algorithm = Constants.CRYPTO.ALGORITHM;
        this.keyPath = resolveProfileKeyPath();
        this.secretKey = this.loadOrCreateSecret();
    }
    ensureSizeFits(payload, options = {}) {
        const maxBytesEnv = process.env.SENTRYFROGG_MAX_PAYLOAD_BYTES || process.env.SF_MAX_PAYLOAD_BYTES;
        const maxBytes = Number.isFinite(options.maxBytes)
            ? options.maxBytes
            : (maxBytesEnv ? Number(maxBytesEnv) : Constants.BUFFERS.MAX_LOG_SIZE);
        const text = typeof payload === 'string' ? payload : String(payload ?? '');
        const bytes = Buffer.byteLength(text, 'utf8');
        if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
            return { ok: true, bytes };
        }
        if (bytes > maxBytes) {
            throw ToolError.invalidParams({
                field: 'payload',
                message: `Payload exceeds size limit (${bytes} bytes > ${maxBytes} bytes)`,
                hint: 'Reduce payload size, or increase SENTRYFROGG_MAX_PAYLOAD_BYTES / SF_MAX_PAYLOAD_BYTES.',
                details: { bytes, max_bytes: maxBytes },
            });
        }
        return { ok: true, bytes, maxBytes };
    }
    loadOrCreateSecret() {
        const fromEnv = decodeKey(process.env.ENCRYPTION_KEY);
        if (fromEnv) {
            this.logger.info('Using encryption key from ENCRYPTION_KEY environment variable');
            return fromEnv;
        }
        try {
            if (fs.existsSync(this.keyPath)) {
                const stored = fs.readFileSync(this.keyPath, 'utf8');
                const decoded = decodeKey(stored);
                if (decoded) {
                    return decoded;
                }
            }
        }
        catch (error) {
            this.logger.warn('Failed to read persisted encryption key, generating new one', { error: error.message });
        }
        const generated = crypto.randomBytes(KEY_BYTES);
        try {
            fs.writeFileSync(this.keyPath, generated.toString('hex'), { encoding: 'utf8', mode: 0o600 });
            this.logger.info('Generated persistent encryption key', { key_path: this.keyPath });
        }
        catch (error) {
            this.logger.warn('Unable to persist encryption key, profiles will need ENCRYPTION_KEY to be set', { error: error.message });
        }
        return generated;
    }
    async encrypt(text) {
        if (typeof text !== 'string') {
            text = String(text ?? '');
        }
        const iv = crypto.randomBytes(IV_BYTES);
        const cipher = crypto.createCipheriv(this.algorithm, this.secretKey, iv);
        const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
        const tag = cipher.getAuthTag();
        return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
    }
    async decrypt(payload) {
        if (!payload || typeof payload !== 'string') {
            throw ToolError.invalidParams({ field: 'payload', message: 'Encrypted payload must be a string' });
        }
        const [ivHex, tagHex, dataHex] = payload.split(':');
        if (!ivHex || !tagHex || !dataHex) {
            throw ToolError.invalidParams({
                field: 'payload',
                message: 'Invalid encrypted payload format',
                hint: 'Expected format: "<iv_hex>:<tag_hex>:<data_hex>".',
            });
        }
        try {
            const iv = Buffer.from(ivHex, 'hex');
            const tag = Buffer.from(tagHex, 'hex');
            const encrypted = Buffer.from(dataHex, 'hex');
            if (tag.length !== TAG_BYTES) {
                throw ToolError.invalidParams({ field: 'payload', message: 'Invalid auth tag length' });
            }
            const decipher = crypto.createDecipheriv(this.algorithm, this.secretKey, iv);
            decipher.setAuthTag(tag);
            const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
            return decrypted.toString('utf8');
        }
        catch (error) {
            throw ToolError.internal({
                code: 'DECRYPT_FAILED',
                message: 'Failed to decrypt secret payload',
                hint: 'Ensure ENCRYPTION_KEY (or the persisted key file) matches the one used to encrypt stored secrets. If keys were rotated, re-create the profile secrets.',
            });
        }
    }
    cleanCommand(command) {
        if (typeof command !== 'string') {
            throw ToolError.invalidParams({ field: 'command', message: 'Command must be a string' });
        }
        const trimmed = command.trim();
        if (!trimmed) {
            throw ToolError.invalidParams({ field: 'command', message: 'Command must not be empty' });
        }
        if (trimmed.includes('\0')) {
            throw ToolError.invalidParams({ field: 'command', message: 'Command contains null bytes' });
        }
        return trimmed;
    }
    ensureUrl(url) {
        if (typeof url !== 'string') {
            throw ToolError.invalidParams({ field: 'url', message: 'URL must be a string' });
        }
        try {
            return new URL(url);
        }
        catch (error) {
            throw ToolError.invalidParams({ field: 'url', message: 'Invalid URL' });
        }
    }
}
module.exports = Security;
