#!/usr/bin/env node

/**
 * 🐘 PostgreSQL manager.
 */

const { URL } = require('url');
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { createWriteStream } = require('fs');
const { Pool } = require('pg');
const Constants = require('../constants/Constants.cjs');
const {
  normalizeTableContext,
  quoteQualifiedIdentifier,
  buildWhereClause,
} = require('../utils/sql.cjs');

class PostgreSQLManager {
  constructor(logger, validation, profileService) {
    this.logger = logger.child('postgres');
    this.validation = validation;
    this.profileService = profileService;
    this.pools = new Map();
    this.stats = {
      queries: 0,
      pools: 0,
      errors: 0,
      profiles_created: 0,
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
      case 'query':
        return this.query(args);
      case 'batch':
        return this.batch(args);
      case 'transaction':
        return this.transaction(args);
      case 'insert':
        return this.insert(args);
      case 'insert_bulk':
        return this.insertBulk(args);
      case 'update':
        return this.update(args);
      case 'delete':
        return this.remove(args);
      case 'select':
        return this.select(args);
      case 'count':
        return this.count(args);
      case 'exists':
        return this.exists(args);
      case 'export':
        return this.exportData(args);
      case 'catalog_tables':
        return this.catalogTables(args);
      case 'catalog_columns':
        return this.catalogColumns(args);
      case 'database_info':
        return this.databaseInfo(args);
      default:
        throw new Error(`Unknown PostgreSQL action: ${action}`);
    }
  }

  parseConnectionUrl(connectionUrl) {
    try {
      const url = new URL(connectionUrl);
      if (!/^postgres(ql)?:$/.test(url.protocol)) {
        throw new Error('Only postgres:// urls are supported');
      }

      const database = url.pathname ? url.pathname.replace(/^\//, '') : undefined;
      const params = Object.fromEntries(url.searchParams.entries());

      const username = url.username ? decodeURIComponent(url.username) : undefined;
      const password = url.password ? decodeURIComponent(url.password) : undefined;

      const { ssl, sslSecrets, remainingParams } = this.parseSslParams(params, url.hostname);

      return {
        data: {
          host: url.hostname || undefined,
          port: url.port ? Number(url.port) : undefined,
          username,
          database,
          ssl,
          options: remainingParams,
        },
        secrets: {
          password,
          ...sslSecrets,
        },
      };
    } catch (error) {
      throw new Error(`Failed to parse connection_url: ${error.message}`);
    }
  }

  parseSslParams(params, hostFromUrl) {
    const sslSecrets = {};
    const remainingParams = { ...params };

    const sslFlags = new Set(['true', '1', 'require', 'verify-ca', 'verify-full']);
    const sslEnv = params.ssl?.toLowerCase();
    const sslMode = params.sslmode?.toLowerCase();

    let ssl = undefined;

    if (sslEnv && sslFlags.has(sslEnv)) {
      ssl = { enabled: true };
    }

    if (sslMode) {
      ssl = ssl || { enabled: true };
      ssl.mode = sslMode;
    }

    if (params.sslrejectunauthorized !== undefined) {
      ssl = ssl || { enabled: true };
      ssl.rejectUnauthorized = params.sslrejectunauthorized !== 'false';
    }

    if (params.sslservername) {
      ssl = ssl || { enabled: true };
      ssl.servername = params.sslservername;
    }

    const pullSecret = (key, target) => {
      if (params[key]) {
        sslSecrets[target] = params[key];
        delete remainingParams[key];
      }
    };

    pullSecret('sslrootcert', 'ssl_ca');
    pullSecret('sslcert', 'ssl_cert');
    pullSecret('sslkey', 'ssl_key');
    pullSecret('sslpassword', 'ssl_passphrase');

    if (ssl && ssl.mode === 'verify-full' && !ssl.servername) {
      ssl.servername = hostFromUrl;
    }

    const cleanupParams = ['ssl', 'sslmode', 'sslrejectunauthorized', 'sslservername'];
    for (const key of cleanupParams) {
      delete remainingParams[key];
    }

    return { ssl, sslSecrets, remainingParams };
  }

  normalizeSslConfig(ssl, secrets) {
    if (ssl === undefined || ssl === null || ssl === false) {
      return undefined;
    }

    if (ssl === true) {
      return true;
    }

    if (typeof ssl !== 'object') {
      return ssl;
    }

    const config = { ...ssl };

    if (secrets.ssl_ca) {
      config.ca = secrets.ssl_ca;
    }
    if (secrets.ssl_cert) {
      config.cert = secrets.ssl_cert;
    }
    if (secrets.ssl_key) {
      config.key = secrets.ssl_key;
    }
    if (secrets.ssl_passphrase) {
      config.passphrase = secrets.ssl_passphrase;
    }

    delete config.enabled;
    delete config.mode;

    return config;
  }

  splitConnectionSecrets(connection) {
    const data = { ...connection };
    const secrets = {};

    if (data.password) {
      secrets.password = data.password;
      delete data.password;
    }

    if (data.ssl && typeof data.ssl === 'object') {
      const sslData = { ...data.ssl };
      if (sslData.ca) {
        secrets.ssl_ca = sslData.ca;
        delete sslData.ca;
      }
      if (sslData.cert) {
        secrets.ssl_cert = sslData.cert;
        delete sslData.cert;
      }
      if (sslData.key) {
        secrets.ssl_key = sslData.key;
        delete sslData.key;
      }
      if (sslData.passphrase) {
        secrets.ssl_passphrase = sslData.passphrase;
        delete sslData.passphrase;
      }
      data.ssl = sslData;
    }

    if (data.connectionString) {
      delete data.connectionString;
    }

    return { data, secrets };
  }

  mergeConnectionProfile(profile) {
    const data = { ...(profile.data || {}) };
    const secrets = { ...(profile.secrets || {}) };

    if (secrets.password) {
      data.password = secrets.password;
    }

    if (data.ssl && typeof data.ssl === 'object') {
      data.ssl = { ...data.ssl };
      if (secrets.ssl_ca) {
        data.ssl.ca = secrets.ssl_ca;
      }
      if (secrets.ssl_cert) {
        data.ssl.cert = secrets.ssl_cert;
      }
      if (secrets.ssl_key) {
        data.ssl.key = secrets.ssl_key;
      }
      if (secrets.ssl_passphrase) {
        data.ssl.passphrase = secrets.ssl_passphrase;
      }
    }

    return data;
  }

  buildPoolConfig(connection) {
    const config = { ...connection };
    if (config.username && !config.user) {
      config.user = config.username;
      delete config.username;
    }

    if (config.ssl) {
      config.ssl = this.normalizeSslConfig(config.ssl, config);
    }

    const poolOptions = config.pool || {};
    delete config.pool;

    const options = config.options || {};
    delete config.options;

    return {
      config: {
        ...options,
        ...config,
      },
      poolOptions,
    };
  }

  buildPoolKey(connection, poolOptions, profileName) {
    if (profileName) {
      return `profile:${profileName}`;
    }
    const payload = JSON.stringify({ connection, poolOptions });
    const hash = crypto.createHash('sha256').update(payload).digest('hex');
    return `inline:${hash}`;
  }

  async getPool(connection, poolOptions = {}, profileName) {
    const key = this.buildPoolKey(connection, poolOptions, profileName);
    if (this.pools.has(key)) {
      return this.pools.get(key);
    }

    const pool = new Pool({
      ...connection,
      ...poolOptions,
      max: poolOptions.max ?? Constants.LIMITS.MAX_CONNECTIONS,
      idleTimeoutMillis: poolOptions.idleTimeoutMillis ?? Constants.TIMEOUTS.IDLE_TIMEOUT,
      connectionTimeoutMillis: poolOptions.connectionTimeoutMillis ?? Constants.TIMEOUTS.CONNECTION_TIMEOUT,
    });

    pool.on('error', (error) => {
      this.logger.warn('PostgreSQL pool error, recreating on next query', {
        error: error.message,
      });
      this.pools.delete(key);
    });

    this.pools.set(key, pool);
    this.stats.pools += 1;
    return pool;
  }

  async resolveProfileName(profileName) {
    if (profileName) {
      return this.validation.ensureString(profileName, 'Profile name');
    }

    const profiles = await this.profileService.listProfiles('postgresql');
    if (profiles.length === 1) {
      return profiles[0].name;
    }

    if (profiles.length === 0) {
      return undefined;
    }

    throw new Error('profile_name is required when multiple profiles exist');
  }

  async resolveConnection(args) {
    const hasInlineConnection = args.connection || args.connection_url;
    if (!hasInlineConnection) {
      const profileName = await this.resolveProfileName(args.profile_name);
      if (!profileName) {
        throw new Error('profile_name or connection is required');
      }

      const profile = await this.profileService.getProfile(profileName, 'postgresql');
      const connection = this.mergeConnectionProfile(profile);
      const { config, poolOptions } = this.buildPoolConfig(connection);
      return { connection: config, poolOptions, profileName };
    }

    const input = args.connection || {};
    const connectionUrl = args.connection_url;
    const base = { ...input };

    if (connectionUrl) {
      base.connectionString = connectionUrl;
    }

    const { config, poolOptions } = this.buildPoolConfig(base);
    return { connection: config, poolOptions, profileName: undefined };
  }

  async profileUpsert(profileName, params) {
    const name = this.validation.ensureString(profileName, 'Profile name');
    const connection = params.connection || {};

    let parsed = { data: {}, secrets: {} };
    if (params.connection_url) {
      parsed = this.parseConnectionUrl(params.connection_url);
    }

    const mergedConnection = {
      ...parsed.data,
      ...connection,
    };

    const { data, secrets } = this.splitConnectionSecrets(mergedConnection);
    const profileData = { ...data };

    if (params.pool) {
      profileData.pool = { ...params.pool };
    }

    if (params.options) {
      profileData.options = { ...params.options };
    }

    const connectionForTest = this.mergeConnectionProfile({ data: profileData, secrets: { ...parsed.secrets, ...secrets } });
    await this.testConnection(connectionForTest, params.pool);

    await this.profileService.setProfile(name, {
      type: 'postgresql',
      data: profileData,
      secrets: { ...parsed.secrets, ...secrets },
    });

    await this.invalidatePool(name);
    this.stats.profiles_created += 1;

    return { success: true, profile: { name, ...profileData } };
  }

  async profileGet(profileName, includeSecrets = false) {
    const name = this.validation.ensureString(profileName, 'Profile name');
    const profile = await this.profileService.getProfile(name, 'postgresql');
    return {
      success: true,
      profile: includeSecrets ? profile : { name: profile.name, type: profile.type, data: profile.data },
    };
  }

  async profileList() {
    const profiles = await this.profileService.listProfiles('postgresql');
    return { success: true, profiles };
  }

  async profileDelete(profileName) {
    const name = this.validation.ensureString(profileName, 'Profile name');
    await this.profileService.deleteProfile(name);
    await this.invalidatePool(name);
    return { success: true, profile: name };
  }

  async profileTest(args) {
    const { connection, poolOptions } = await this.resolveConnection(args);
    await this.testConnection(connection, poolOptions);
    return { success: true };
  }

  async invalidatePool(profileName) {
    const key = `profile:${profileName}`;
    const existingPool = this.pools.get(key);
    if (!existingPool) {
      return;
    }

    this.pools.delete(key);
    try {
      await existingPool.end();
    } catch (error) {
      this.logger.warn('Failed to close PostgreSQL pool during invalidation', {
        profile: profileName,
        error: error.message,
      });
    }
  }

  async testConnection(connection, poolOptions) {
    const pool = new Pool({
      ...connection,
      ...poolOptions,
      max: 1,
    });

    try {
      const client = await pool.connect();
      await client.query('SELECT 1');
      client.release();
    } finally {
      await pool.end();
    }
  }

  async executeQuery(pool, sql, params, mode, timeoutMs) {
    const queryConfig = { text: sql };
    if (Array.isArray(params)) {
      queryConfig.values = params;
    }
    if (timeoutMs !== undefined && timeoutMs !== null) {
      queryConfig.query_timeout = Number(timeoutMs);
    }

    const started = Date.now();
    const result = await pool.query(queryConfig);
    this.stats.queries += 1;

    const payload = {
      success: true,
      command: result.command,
      rowCount: result.rowCount,
      fields: result.fields?.map((field) => ({ name: field.name, dataTypeId: field.dataTypeID })),
      duration_ms: Date.now() - started,
    };

    const normalizedMode = (mode || 'rows').toLowerCase();
    if (normalizedMode === 'row') {
      payload.row = result.rows[0] ?? null;
      return payload;
    }

    if (normalizedMode === 'value') {
      const firstRow = result.rows[0];
      payload.value = firstRow ? firstRow[Object.keys(firstRow)[0]] : null;
      return payload;
    }

    if (normalizedMode === 'command') {
      return payload;
    }

    payload.rows = result.rows;
    return payload;
  }

  normalizeLimit(value, label) {
    if (value === undefined || value === null) {
      return undefined;
    }
    const numeric = Number(value);
    if (!Number.isInteger(numeric) || numeric < 0) {
      throw new Error(`${label} must be a non-negative integer`);
    }
    return numeric;
  }

  normalizeColumns(columns, columnsSql) {
    if (columnsSql) {
      return String(columnsSql);
    }
    if (!columns) {
      return '*';
    }
    if (Array.isArray(columns)) {
      if (columns.length === 0) {
        throw new Error('columns must be a non-empty array');
      }
      return columns.map((col) => quoteQualifiedIdentifier(col)).join(', ');
    }
    const trimmed = String(columns).trim();
    if (trimmed === '*') {
      return '*';
    }
    if (!trimmed) {
      throw new Error('columns must be a non-empty string');
    }
    return quoteQualifiedIdentifier(trimmed);
  }

  buildOrderBy(orderBy, orderBySql) {
    if (orderBySql) {
      return ` ORDER BY ${orderBySql}`;
    }
    if (!orderBy) {
      return '';
    }
    const normalizeEntry = (entry) => {
      if (typeof entry === 'string') {
        return { column: entry, direction: 'ASC' };
      }
      if (entry && typeof entry === 'object') {
        return {
          column: entry.column || entry.field,
          direction: entry.direction || entry.dir || 'ASC',
        };
      }
      throw new Error('order_by entries must be strings or objects');
    };

    const entries = Array.isArray(orderBy) ? orderBy : [orderBy];
    const parts = entries.map((entry) => {
      const normalized = normalizeEntry(entry);
      if (!normalized.column) {
        throw new Error('order_by entry missing column');
      }
      const direction = String(normalized.direction || 'ASC').toUpperCase();
      if (!['ASC', 'DESC'].includes(direction)) {
        throw new Error('order_by direction must be ASC or DESC');
      }
      return `${quoteQualifiedIdentifier(normalized.column)} ${direction}`;
    });

    return parts.length > 0 ? ` ORDER BY ${parts.join(', ')}` : '';
  }

  buildSelectQuery(args, { mode } = {}) {
    const context = normalizeTableContext(args.table, args.schema);
    const columnsSql = this.normalizeColumns(args.columns, args.columns_sql);

    const where = buildWhereClause({
      filters: args.filters,
      whereSql: args.where_sql,
      whereParams: args.where_params,
      startIndex: 1,
    });

    const orderBySql = mode === 'select'
      ? this.buildOrderBy(args.order_by, args.order_by_sql)
      : '';

    const limit = mode === 'select' ? this.normalizeLimit(args.limit, 'limit') : undefined;
    const offset = mode === 'select' ? this.normalizeLimit(args.offset, 'offset') : undefined;

    const whereSql = where.clause ? ` WHERE ${where.clause}` : '';
    const limitSql = limit !== undefined ? ` LIMIT ${limit}` : '';
    const offsetSql = offset !== undefined ? ` OFFSET ${offset}` : '';

    const sql = `SELECT ${columnsSql} FROM ${context.qualified}${whereSql}${orderBySql}${limitSql}${offsetSql}`;
    return { sql, params: where.params, context };
  }

  async query(args) {
    const text = this.validation.ensureSql(args.sql);
    const { connection, poolOptions, profileName } = await this.resolveConnection(args);
    const pool = await this.getPool(connection, poolOptions, profileName);

    try {
      return await this.executeQuery(pool, text, args.params, args.mode, args.timeout_ms);
    } catch (error) {
      this.stats.errors += 1;
      this.logger.error('Query failed', { error: error.message });
      throw error;
    }
  }

  async batch(args) {
    const statements = Array.isArray(args.statements) ? args.statements : [];
    if (statements.length === 0) {
      throw new Error('statements must be a non-empty array');
    }

    const { connection, poolOptions, profileName } = await this.resolveConnection(args);
    const pool = await this.getPool(connection, poolOptions, profileName);

    const transactional = !!args.transactional;
    const results = [];

    const runStatement = async (statement) => {
      const sql = this.validation.ensureSql(statement.sql);
      return this.executeQuery(pool, sql, statement.params, statement.mode, statement.timeout_ms);
    };

    if (!transactional) {
      for (const statement of statements) {
        results.push(await runStatement(statement));
      }
      return { success: true, results };
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const statement of statements) {
        const sql = this.validation.ensureSql(statement.sql);
        const result = await this.executeQuery(client, sql, statement.params, statement.mode, statement.timeout_ms);
        results.push(result);
      }
      await client.query('COMMIT');
      return { success: true, results };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async transaction(args) {
    return this.batch({ ...args, transactional: true });
  }

  async insert(args) {
    const context = normalizeTableContext(args.table, args.schema);
    const payload = this.validation.ensureDataObject(args.data);
    const returning = args.returning;

    const columns = Object.keys(payload).map((col) => quoteQualifiedIdentifier(col));
    const values = Object.values(payload);
    const placeholders = values.map((_, index) => `$${index + 1}`);

    const returnSql = Array.isArray(returning)
      ? ` RETURNING ${returning.map((col) => quoteQualifiedIdentifier(col)).join(', ')}`
      : typeof returning === 'string'
        ? ` RETURNING ${quoteQualifiedIdentifier(returning)}`
        : returning
          ? ' RETURNING *'
          : '';

    const sql = `INSERT INTO ${context.qualified} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})${returnSql}`;

    const { connection, poolOptions, profileName } = await this.resolveConnection(args);
    const pool = await this.getPool(connection, poolOptions, profileName);

    const result = await this.executeQuery(pool, sql, values, args.mode, args.timeout_ms);
    return { success: true, table: context.table, schema: context.schema, ...result };
  }

  async insertBulk(args) {
    const context = normalizeTableContext(args.table, args.schema);
    const rows = args.rows || args.data;
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new Error('rows must be a non-empty array');
    }

    const returning = args.returning;
    let columns = Array.isArray(args.columns) ? args.columns : null;

    if (!columns) {
      const first = rows[0];
      if (!first || typeof first !== 'object' || Array.isArray(first)) {
        throw new Error('rows must be objects or provide columns');
      }
      columns = Object.keys(first);
    }

    if (!Array.isArray(columns) || columns.length === 0) {
      throw new Error('columns must be a non-empty array');
    }

    const columnSql = columns.map((col) => quoteQualifiedIdentifier(col));
    const returnSql = Array.isArray(returning)
      ? ` RETURNING ${returning.map((col) => quoteQualifiedIdentifier(col)).join(', ')}`
      : typeof returning === 'string'
        ? ` RETURNING ${quoteQualifiedIdentifier(returning)}`
        : returning
          ? ' RETURNING *'
          : '';

    const maxParams = 65535;
    const maxBatchSize = Math.max(1, Math.floor(maxParams / columnSql.length));
    const requestedBatch = Number.isFinite(args.batch_size) ? Number(args.batch_size) : 500;
    const batchSize = Math.min(requestedBatch, maxBatchSize);

    const { connection, poolOptions, profileName } = await this.resolveConnection(args);
    const pool = await this.getPool(connection, poolOptions, profileName);

    let inserted = 0;
    const allRows = [];

    for (let offset = 0; offset < rows.length; offset += batchSize) {
      const batch = rows.slice(offset, offset + batchSize);
      const values = [];
      const placeholders = batch.map((row, rowIndex) => {
        let payload = row;
        if (Array.isArray(row)) {
          payload = {};
          columns.forEach((col, colIndex) => {
            payload[col] = row[colIndex];
          });
        }
        if (!payload || typeof payload !== 'object') {
          throw new Error('Each row must be an object or array');
        }
        const rowValues = columns.map((col) => payload[col]);
        rowValues.forEach((value) => values.push(value));
        const startIndex = rowIndex * columnSql.length;
        const rowPlaceholders = columnSql.map((_, colIndex) => `$${startIndex + colIndex + 1}`);
        return `(${rowPlaceholders.join(', ')})`;
      });

      const sql = `INSERT INTO ${context.qualified} (${columnSql.join(', ')}) VALUES ${placeholders.join(', ')}${returnSql}`;
      const result = await this.executeQuery(pool, sql, values, args.mode, args.timeout_ms);
      inserted += batch.length;
      if (returning) {
        if (Array.isArray(result.rows)) {
          allRows.push(...result.rows);
        } else if (result.row) {
          allRows.push(result.row);
        }
      }
    }

    return {
      success: true,
      table: context.table,
      schema: context.schema,
      inserted,
      batches: Math.ceil(rows.length / batchSize),
      rows: returning ? allRows : undefined,
    };
  }

  async update(args) {
    const context = normalizeTableContext(args.table, args.schema);
    const payload = this.validation.ensureDataObject(args.data);

    const columns = Object.keys(payload).map((col) => quoteQualifiedIdentifier(col));
    const values = Object.values(payload);
    const assignments = columns.map((col, index) => `${col} = $${index + 1}`);

    const where = buildWhereClause({
      filters: args.filters,
      whereSql: args.where_sql,
      whereParams: args.where_params,
      startIndex: values.length + 1,
    });

    const returnSql = Array.isArray(args.returning)
      ? ` RETURNING ${args.returning.map((col) => quoteQualifiedIdentifier(col)).join(', ')}`
      : typeof args.returning === 'string'
        ? ` RETURNING ${quoteQualifiedIdentifier(args.returning)}`
        : args.returning
          ? ' RETURNING *'
          : '';

    const whereSql = where.clause ? ` WHERE ${where.clause}` : '';
    const sql = `UPDATE ${context.qualified} SET ${assignments.join(', ')}${whereSql}${returnSql}`;

    const { connection, poolOptions, profileName } = await this.resolveConnection(args);
    const pool = await this.getPool(connection, poolOptions, profileName);

    const result = await this.executeQuery(pool, sql, [...values, ...where.params], args.mode, args.timeout_ms);
    return { success: true, table: context.table, schema: context.schema, ...result };
  }

  async remove(args) {
    const context = normalizeTableContext(args.table, args.schema);

    const where = buildWhereClause({
      filters: args.filters,
      whereSql: args.where_sql,
      whereParams: args.where_params,
      startIndex: 1,
    });

    const returnSql = Array.isArray(args.returning)
      ? ` RETURNING ${args.returning.map((col) => quoteQualifiedIdentifier(col)).join(', ')}`
      : typeof args.returning === 'string'
        ? ` RETURNING ${quoteQualifiedIdentifier(args.returning)}`
        : args.returning
          ? ' RETURNING *'
          : '';

    const whereSql = where.clause ? ` WHERE ${where.clause}` : '';
    const sql = `DELETE FROM ${context.qualified}${whereSql}${returnSql}`;

    const { connection, poolOptions, profileName } = await this.resolveConnection(args);
    const pool = await this.getPool(connection, poolOptions, profileName);

    const result = await this.executeQuery(pool, sql, where.params, args.mode, args.timeout_ms);
    return { success: true, table: context.table, schema: context.schema, ...result };
  }

  async select(args) {
    const { sql, params, context } = this.buildSelectQuery(args, { mode: 'select' });
    const { connection, poolOptions, profileName } = await this.resolveConnection(args);
    const pool = await this.getPool(connection, poolOptions, profileName);
    const result = await this.executeQuery(pool, sql, params, args.mode, args.timeout_ms);
    return { success: true, table: context.table, schema: context.schema, ...result };
  }

  async count(args) {
    const context = normalizeTableContext(args.table, args.schema);
    const where = buildWhereClause({
      filters: args.filters,
      whereSql: args.where_sql,
      whereParams: args.where_params,
      startIndex: 1,
    });
    const whereSql = where.clause ? ` WHERE ${where.clause}` : '';
    const sql = `SELECT COUNT(*) AS count FROM ${context.qualified}${whereSql}`;

    const { connection, poolOptions, profileName } = await this.resolveConnection(args);
    const pool = await this.getPool(connection, poolOptions, profileName);
    const result = await this.executeQuery(pool, sql, where.params, 'row', args.timeout_ms);
    return { success: true, table: context.table, schema: context.schema, count: Number(result.row?.count || 0) };
  }

  async exists(args) {
    const context = normalizeTableContext(args.table, args.schema);
    const where = buildWhereClause({
      filters: args.filters,
      whereSql: args.where_sql,
      whereParams: args.where_params,
      startIndex: 1,
    });
    const whereSql = where.clause ? ` WHERE ${where.clause}` : '';
    const sql = `SELECT EXISTS(SELECT 1 FROM ${context.qualified}${whereSql}) AS exists`;

    const { connection, poolOptions, profileName } = await this.resolveConnection(args);
    const pool = await this.getPool(connection, poolOptions, profileName);
    const result = await this.executeQuery(pool, sql, where.params, 'row', args.timeout_ms);
    return { success: true, table: context.table, schema: context.schema, exists: result.row?.exists === true };
  }

  async exportData(args) {
    const format = String(args.format || 'csv').toLowerCase();
    if (!['csv', 'jsonl'].includes(format)) {
      throw new Error('format must be csv or jsonl');
    }

    const filePath = args.file_path;
    if (!filePath) {
      throw new Error('file_path is required');
    }

    const batchSize = this.normalizeLimit(args.batch_size ?? 1000, 'batch_size') ?? 1000;
    const baseOffset = this.normalizeLimit(args.offset ?? 0, 'offset') ?? 0;
    const limit = this.normalizeLimit(args.limit, 'limit');

    const context = normalizeTableContext(args.table, args.schema);
    const columnsSql = this.normalizeColumns(args.columns, args.columns_sql);
    const orderBySql = this.buildOrderBy(args.order_by, args.order_by_sql);

    const where = buildWhereClause({
      filters: args.filters,
      whereSql: args.where_sql,
      whereParams: args.where_params,
      startIndex: 1,
    });

    const whereSql = where.clause ? ` WHERE ${where.clause}` : '';

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const stream = createWriteStream(filePath, { encoding: 'utf8' });
    const started = Date.now();

    const writeLine = (line) => new Promise((resolve, reject) => {
      stream.write(line, (error) => (error ? reject(error) : resolve()));
    });

    const { connection, poolOptions, profileName } = await this.resolveConnection(args);
    const pool = await this.getPool(connection, poolOptions, profileName);

    let offset = baseOffset;
    let rowsWritten = 0;
    let headerWritten = false;
    let columns = null;

    const csvEscape = (value) => {
      if (value === null || value === undefined) {
        return '';
      }
      const raw = String(value);
      if (raw.includes('"') || raw.includes(',') || raw.includes('\n')) {
        return `"${raw.replace(/"/g, '""')}"`;
      }
      return raw;
    };

    try {
      while (true) {
        const pageLimit = limit !== undefined ? Math.min(batchSize, limit - rowsWritten) : batchSize;
        if (pageLimit <= 0) {
          break;
        }

        const sql = `SELECT ${columnsSql} FROM ${context.qualified}${whereSql}${orderBySql} LIMIT ${pageLimit} OFFSET ${offset}`;
        const result = await this.executeQuery(pool, sql, where.params, 'rows', args.timeout_ms);
        const rows = result.rows || [];

        if (!headerWritten && format === 'csv') {
          columns = result.fields?.map((field) => field.name) || (rows[0] ? Object.keys(rows[0]) : []);
          if (columns.length > 0) {
            await writeLine(`${columns.map(csvEscape).join(',')}\n`);
          }
          headerWritten = true;
        }

        if (rows.length === 0) {
          break;
        }

        for (const row of rows) {
          if (format === 'jsonl') {
            await writeLine(`${JSON.stringify(row)}\n`);
          } else {
            const rowColumns = columns || Object.keys(row);
            await writeLine(`${rowColumns.map((col) => csvEscape(row[col])).join(',')}\n`);
          }
          rowsWritten += 1;
          if (limit !== undefined && rowsWritten >= limit) {
            break;
          }
        }

        if (limit !== undefined && rowsWritten >= limit) {
          break;
        }

        offset += pageLimit;
      }
    } finally {
      await new Promise((resolve) => stream.end(resolve));
    }

    return {
      success: true,
      table: context.table,
      schema: context.schema,
      file_path: filePath,
      format,
      rows_written: rowsWritten,
      duration_ms: Date.now() - started,
    };
  }

  async catalogTables(args) {
    const schema = args.schema ? this.validation.ensureSchemaName(args.schema) : undefined;
    const sql = `
      SELECT schemaname AS schema,
             tablename AS name,
             tableowner AS owner,
             hasindexes,
             hasrules,
             hastriggers
      FROM pg_tables
      WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
      ${schema ? 'AND schemaname = $1' : ''}
      ORDER BY schemaname, tablename
    `;

    return this.query({ ...args, sql, params: schema ? [schema] : [] });
  }

  async catalogColumns(args) {
    const name = this.validation.ensureTableName(args.table);
    const schema = this.validation.ensureSchemaName(args.schema ?? 'public');

    const sql = `
      SELECT column_name,
             data_type,
             is_nullable,
             column_default,
             character_maximum_length,
             numeric_precision,
             numeric_scale
      FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
      ORDER BY ordinal_position
    `;

    const result = await this.query({ ...args, sql, params: [schema, name], mode: 'rows' });
    return { success: true, table: name, schema, columns: result.rows };
  }

  async databaseInfo(args) {
    const sql = `SELECT current_database() AS database_name,
                        current_user AS current_user,
                        version() AS version,
                        pg_size_pretty(pg_database_size(current_database())) AS size`;
    return this.query({ ...args, sql });
  }

  getStats() {
    return { ...this.stats, activePools: this.pools.size };
  }

  async cleanup() {
    for (const pool of this.pools.values()) {
      await pool.end();
    }
    this.pools.clear();
  }
}

module.exports = PostgreSQLManager;
