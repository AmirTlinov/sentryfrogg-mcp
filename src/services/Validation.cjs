#!/usr/bin/env node

/**
 * ✅ Простая валидация входных данных
 */

const Constants = require('../constants/Constants.cjs');

class Validation {
  constructor(logger) {
    this.logger = logger.child('validation');
  }

  ensureString(value, label) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`${label} must be a non-empty string`);
    }
    return value.trim();
  }

  ensureOptionalString(value, label) {
    if (value === undefined || value === null) {
      return undefined;
    }
    return this.ensureString(value, label);
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

  ensureLimit(limit, defaultValue = Constants.LIMITS.DEFAULT_QUERY_LIMIT) {
    if (limit === undefined || limit === null) {
      return defaultValue;
    }
    const numeric = Number(limit);
    if (!Number.isInteger(numeric) || numeric < Constants.LIMITS.MIN_QUERY_LIMIT || numeric > Constants.LIMITS.MAX_QUERY_LIMIT) {
      throw new Error(`Limit must be between ${Constants.LIMITS.MIN_QUERY_LIMIT} and ${Constants.LIMITS.MAX_QUERY_LIMIT}`);
    }
    return numeric;
  }

  ensureTableName(name) {
    const trimmed = this.ensureString(name, 'Table name');
    const pattern = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
    if (!pattern.test(trimmed)) {
      throw new Error('Table name may contain only letters, digits and underscores, starting with letter or underscore');
    }
    if (trimmed.length > Constants.LIMITS.MAX_TABLE_NAME_LENGTH) {
      throw new Error(`Table name must be ${Constants.LIMITS.MAX_TABLE_NAME_LENGTH} characters or less`);
    }
    return trimmed;
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

  ensureConnectionProfile(profile, { requireDatabase = false, defaultPort, requirePassword = true } = {}) {
    if (typeof profile !== 'object' || profile === null) {
      throw new Error('Profile must be an object');
    }

    const normalized = {
      host: this.ensureString(profile.host, 'Host'),
      port: this.ensurePort(profile.port, defaultPort),
      username: this.ensureString(profile.username, 'Username'),
    };

    if (requirePassword) {
      normalized.password = this.ensureString(profile.password, 'Password');
    } else if (profile.password !== undefined) {
      normalized.password = this.ensureString(profile.password, 'Password');
    }

    if (requireDatabase) {
      normalized.database = this.ensureString(profile.database, 'Database name');
    } else if (profile.database) {
      normalized.database = this.ensureString(profile.database, 'Database name');
    }

    return normalized;
  }

  ensureSql(sql) {
    return this.ensureString(sql, 'SQL query');
  }

  ensureWhereClause(where) {
    return this.ensureString(where, 'WHERE clause');
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
        .filter(([key, value]) => typeof key === 'string' && typeof value === 'string')
        .map(([key, value]) => [key.trim(), value.trim()])
    );
  }
}

module.exports = Validation;
