#!/usr/bin/env node
// @ts-nocheck

/**
 * ✅ Простая валидация входных данных
 */

const Constants = require('../constants/Constants');

class Validation {
  constructor(logger) {
    this.logger = logger.child('validation');
  }

  ensureString(value, label, { trim = true } = {}) {
    if (typeof value !== 'string') {
      throw new Error(`${label} must be a non-empty string`);
    }

    const normalized = value.trim();
    if (normalized.length === 0) {
      throw new Error(`${label} must be a non-empty string`);
    }

    return trim ? normalized : value;
  }

  ensureOptionalString(value, label, options) {
    if (value === undefined || value === null) {
      return undefined;
    }
    return this.ensureString(value, label, options);
  }

  ensurePort(port, fallback) {
    if (port === undefined || port === null || port === '') {
      return fallback;
    }

    const numeric = Number(port);
    if (!Number.isInteger(numeric) || numeric < Constants.LIMITS.MIN_PORT || numeric > Constants.LIMITS.MAX_PORT) {
      throw new Error(`Port must be an integer between ${Constants.LIMITS.MIN_PORT} and ${Constants.LIMITS.MAX_PORT}`);
    }
    return numeric;
  }

  ensureIdentifier(name, label) {
    const trimmed = this.ensureString(name, label);
    if (trimmed.includes('\0')) {
      throw new Error(`${label} must not contain null bytes`);
    }
    return trimmed;
  }

  ensureTableName(name) {
    return this.ensureIdentifier(name, 'Table name');
  }

  ensureSchemaName(name) {
    return this.ensureIdentifier(name, 'Schema name');
  }

  ensureDataObject(data) {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      throw new Error('Data must be an object');
    }
    if (Object.keys(data).length === 0) {
      throw new Error('Data object must not be empty');
    }
    return data;
  }

  ensureSql(sql) {
    return this.ensureString(sql, 'SQL query');
  }

  ensureHeaders(headers) {
    if (headers === undefined || headers === null) {
      return {};
    }

    if (typeof headers !== 'object' || Array.isArray(headers)) {
      throw new Error('Headers must be an object');
    }

    return Object.fromEntries(
      Object.entries(headers)
        .filter(([key]) => typeof key === 'string' && key.trim().length > 0)
        .flatMap(([key, value]) => {
          if (value === undefined || value === null) {
            return [];
          }
          return [[key.trim(), String(value).trim()]];
        })
    );
  }

  ensureObject(value, label) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`${label} must be an object`);
    }
    return value;
  }

  ensureOptionalObject(value, label) {
    if (value === undefined || value === null) {
      return undefined;
    }
    return this.ensureObject(value, label);
  }
}

module.exports = Validation;
