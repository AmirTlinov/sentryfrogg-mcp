#!/usr/bin/env node

/**
 * 🔐 Упрощённая система безопасности
 * Держит совместимость с профилями и минимально проверяет ввод.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Constants = require('../constants/Constants.cjs');

const KEY_BYTES = Constants.BUFFERS.CRYPTO_KEY_SIZE;
const IV_BYTES = Constants.BUFFERS.CRYPTO_IV_SIZE;

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
    } catch (error) {
      return null;
    }
  }

  return null;
}

class Security {
  constructor(logger) {
    this.logger = logger.child('security');
    this.algorithm = Constants.CRYPTO.ALGORITHM;
    this.keyPath = process.env.MCP_PROFILE_KEY_PATH || path.join(process.cwd(), '.mcp_profiles.key');
    this.secretKey = this.loadOrCreateSecret();
    this.limits = {
      maxDataSize: Constants.LIMITS.MAX_DATA_SIZE,
      maxPasswordLength: Constants.LIMITS.MAX_PASSWORD_LENGTH,
      maxCommandLength: Constants.LIMITS.MAX_COMMAND_LENGTH,
      maxUrlLength: Constants.LIMITS.MAX_URL_LENGTH,
    };
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
    } catch (error) {
      this.logger.warn('Failed to read persisted encryption key, generating new one', { error: error.message });
    }

    const generated = crypto.randomBytes(KEY_BYTES);
    try {
      fs.writeFileSync(this.keyPath, generated.toString('hex'), { encoding: 'utf8', mode: 0o600 });
      this.logger.info('Generated persistent encryption key', { key_path: this.keyPath });
    } catch (error) {
      this.logger.warn('Unable to persist encryption key, profiles will need ENCRYPTION_KEY to be set', { error: error.message });
    }

    return generated;
  }

  ensureSizeFits(text) {
    const size = Buffer.byteLength(String(text), 'utf8');
    if (size > this.limits.maxDataSize) {
      throw new Error(`Payload too large (${size} bytes)`);
    }
  }

  async encrypt(text) {
    if (typeof text !== 'string') {
      text = String(text ?? '');
    }

    this.ensureSizeFits(text);

    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(this.algorithm, this.secretKey, iv);
    const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return `${iv.toString('hex')}:${encrypted.toString('hex')}`;
  }

  async decrypt(payload) {
    if (!payload || typeof payload !== 'string') {
      throw new Error('Encrypted payload must be a string');
    }

    const [ivHex, dataHex] = payload.split(':');
    if (!ivHex || !dataHex) {
      throw new Error('Invalid encrypted payload format');
    }

    try {
      const iv = Buffer.from(ivHex, 'hex');
      const encrypted = Buffer.from(dataHex, 'hex');
      const decipher = crypto.createDecipheriv(this.algorithm, this.secretKey, iv);
      const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
      return decrypted.toString('utf8');
    } catch (error) {
      throw new Error('Failed to decrypt profile password');
    }
  }

  cleanCommand(command) {
    if (typeof command !== 'string') {
      throw new Error('Command must be a string');
    }

    const trimmed = command.trim();
    if (!trimmed) {
      throw new Error('Command must not be empty');
    }

    if (trimmed.length > this.limits.maxCommandLength) {
      throw new Error(`Command is too long (>${this.limits.maxCommandLength} characters)`);
    }

    if (trimmed.includes('\0')) {
      throw new Error('Command contains null bytes');
    }

    return trimmed;
  }

  ensureUrl(url) {
    if (typeof url !== 'string') {
      throw new Error('URL must be a string');
    }

    if (url.length > this.limits.maxUrlLength) {
      throw new Error('URL is too long');
    }

    try {
      return new URL(url);
    } catch (error) {
      throw new Error('Invalid URL');
    }
  }
}

module.exports = Security;
