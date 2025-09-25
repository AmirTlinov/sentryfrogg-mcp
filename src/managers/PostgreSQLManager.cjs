#!/usr/bin/env node

/**
 * 🐘 PostgreSQL менеджер.
 * Простой API, дружелюбный к агентам.
 */

const { URL } = require('url');
const { Pool } = require('pg');
const Constants = require('../constants/Constants.cjs');

class PostgreSQLManager {
  constructor(logger, _security, validation, profileService) {
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
    const { action, profile_name = 'default' } = args;

    switch (action) {
      case 'setup_profile':
        return this.setupProfile(profile_name, args);
      case 'list_profiles':
        return this.listProfiles();
      case 'quick_query':
        return this.executeQuery(profile_name, args.sql, args.limit, args.params);
      case 'show_tables':
        return this.showTables(profile_name);
      case 'describe_table':
        return this.describeTable(profile_name, args.table_name);
      case 'sample_data':
        return this.sampleData(profile_name, args.table_name, args.limit);
      case 'insert_data':
        return this.insertData(profile_name, args.table_name, args.data);
      case 'update_data':
        return this.updateData(profile_name, args.table_name, args.data, args.where);
      case 'delete_data':
        return this.deleteData(profile_name, args.table_name, args.where);
      case 'database_info':
        return this.databaseInfo(profile_name);
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

      return {
        host: url.hostname,
        port: url.port ? Number(url.port) : undefined,
        username,
        password,
        database,
        ...this.parseSslParams(params, url.hostname),
      };
    } catch (error) {
      throw new Error(`Failed to parse connection_url: ${error.message}`);
    }
  }

  parseSslParams(params, hostFromUrl) {
    const sslParams = {};

    const sslFlags = new Set([
      'true',
      '1',
      'require',
      'verify-ca',
      'verify-full',
    ]);

    const sslEnv = params.ssl?.toLowerCase();
    const sslMode = params.sslmode?.toLowerCase();

    if (sslEnv && sslFlags.has(sslEnv)) {
      sslParams.ssl = { enabled: true };
    }

    if (sslMode) {
      sslParams.ssl = sslParams.ssl || { enabled: true };
      sslParams.ssl.mode = sslMode;
    }

    if (params.sslrejectunauthorized) {
      sslParams.ssl = sslParams.ssl || { enabled: true };
      sslParams.ssl.rejectUnauthorized = params.sslrejectunauthorized !== 'false';
    }

    if (params.sslservername) {
      sslParams.ssl = sslParams.ssl || { enabled: true };
      sslParams.ssl.servername = params.sslservername;
    }

    if (params.sslrootcert) {
      sslParams.ssl_ca = params.sslrootcert;
      sslParams.ssl = sslParams.ssl || { enabled: true };
    }

    if (params.sslcert) {
      sslParams.ssl_cert = params.sslcert;
      sslParams.ssl = sslParams.ssl || { enabled: true };
    }

    if (params.sslkey) {
      sslParams.ssl_key = params.sslkey;
      sslParams.ssl = sslParams.ssl || { enabled: true };
    }

    if (params.sslpassword) {
      sslParams.ssl_passphrase = params.sslpassword;
      sslParams.ssl = sslParams.ssl || { enabled: true };
    }

    if (sslParams.ssl && !sslParams.ssl.servername && sslParams.ssl.mode === 'verify-full') {
      sslParams.ssl.servername = hostFromUrl;
    }

    return sslParams;
  }

  async setupProfile(name, params) {
    let baseConfig = {};
    if (params.connection_url) {
      baseConfig = this.parseConnectionUrl(params.connection_url);
    }

    const profileInput = {
      host: params.host ?? baseConfig.host,
      port: params.port ?? baseConfig.port,
      username: params.username ?? baseConfig.username,
      password: params.password ?? baseConfig.password,
      database: params.database ?? baseConfig.database,
    };

    const validated = this.validation.ensureConnectionProfile(profileInput, {
      requireDatabase: true,
      defaultPort: Constants.NETWORK.POSTGRES_DEFAULT_PORT,
      requirePassword: profileInput.password !== undefined,
    });

    const { ssl, secrets: sslSecrets } = this.normalizeSslSettings(params, baseConfig);

    const finalProfile = {
      ...validated,
      ssl,
      type: 'postgresql',
    };

    if (params.connection_url) {
      finalProfile.connection_url = params.connection_url;
    }

    Object.assign(finalProfile, sslSecrets);

    await this.testConnection(finalProfile);
    await this.profileService.setProfile(name, finalProfile);
    this.stats.profiles_created += 1;

    return {
      success: true,
      message: `PostgreSQL profile '${name}' saved`,
      profile: {
        name,
        host: finalProfile.host,
        port: finalProfile.port,
        username: finalProfile.username,
        database: finalProfile.database,
        ssl: finalProfile.ssl,
      },
    };
  }

  async listProfiles() {
    const profiles = await this.profileService.listProfiles('postgresql');
    return { success: true, profiles };
  }

  buildPoolConfig(profile) {
    return {
      host: profile.host,
      port: profile.port,
      user: profile.username,
      password: profile.password,
      database: profile.database,
      max: Constants.LIMITS.MAX_CONNECTIONS,
      idleTimeoutMillis: Constants.TIMEOUTS.IDLE_TIMEOUT,
      connectionTimeoutMillis: Constants.TIMEOUTS.CONNECTION_TIMEOUT,
      ssl: this.buildSslConfig(profile),
    };
  }

  normalizeSslSettings(params, baseConfig) {
    const directSsl = params.ssl;
    const baseSsl = baseConfig.ssl;

    const secrets = {};

    const collectSecret = (key, value) => {
      if (value === undefined || value === null || value === '') {
        return;
      }
      secrets[key] = value;
    };

    const merged = {
      mode: params.ssl_mode ?? baseSsl?.mode,
      rejectUnauthorized: params.ssl_reject_unauthorized ?? baseSsl?.rejectUnauthorized,
      servername: params.ssl_servername ?? baseSsl?.servername,
    };

    collectSecret('ssl_ca', params.ssl_ca ?? baseConfig.ssl_ca);
    collectSecret('ssl_cert', params.ssl_cert ?? baseConfig.ssl_cert);
    collectSecret('ssl_key', params.ssl_key ?? baseConfig.ssl_key);
    collectSecret('ssl_passphrase', params.ssl_passphrase ?? baseConfig.ssl_passphrase);

    let enabled = false;

    if (typeof directSsl === 'boolean') {
      enabled = directSsl;
    } else if (typeof directSsl === 'string') {
      const lowered = directSsl.toLowerCase();
      enabled = ['true', '1', 'require', 'verify-ca', 'verify-full'].includes(lowered);
      if (!merged.mode && ['require', 'verify-ca', 'verify-full'].includes(lowered)) {
        merged.mode = lowered;
      }
    } else if (typeof directSsl === 'object' && directSsl) {
      enabled = directSsl.enabled ?? true;
      merged.mode = directSsl.mode ?? merged.mode;
      if (directSsl.rejectUnauthorized !== undefined) {
        merged.rejectUnauthorized = directSsl.rejectUnauthorized;
      }
      merged.servername = directSsl.servername ?? merged.servername;
      collectSecret('ssl_ca', directSsl.ca ?? directSsl.rootCert);
      collectSecret('ssl_cert', directSsl.cert);
      collectSecret('ssl_key', directSsl.key);
      collectSecret('ssl_passphrase', directSsl.passphrase);
    }

    if (typeof baseSsl === 'boolean') {
      enabled = enabled || baseSsl;
    } else if (typeof baseSsl === 'object' && baseSsl) {
      const baseEnabled = baseSsl.enabled !== undefined ? baseSsl.enabled : true;
      enabled = enabled || baseEnabled;
      merged.mode = merged.mode ?? baseSsl.mode;
      if (baseSsl.rejectUnauthorized !== undefined) {
        merged.rejectUnauthorized = merged.rejectUnauthorized ?? baseSsl.rejectUnauthorized;
      }
      merged.servername = merged.servername ?? baseSsl.servername;
      collectSecret('ssl_ca', baseSsl.ca ?? baseSsl.rootCert);
      collectSecret('ssl_cert', baseSsl.cert);
      collectSecret('ssl_key', baseSsl.key);
      collectSecret('ssl_passphrase', baseSsl.passphrase);
    }

    if (!enabled && Object.keys(secrets).length > 0) {
      enabled = true;
    }

    if (merged.mode) {
      const mode = merged.mode.toLowerCase();
      if (mode === 'disable') {
        enabled = false;
      } else if (mode === 'require') {
        enabled = true;
        merged.rejectUnauthorized = false;
      } else if (mode === 'verify-ca' || mode === 'verifyfull' || mode === 'verify-full') {
        enabled = true;
        merged.rejectUnauthorized = true;
        if (!merged.servername && mode.startsWith('verify')) {
          merged.servername = params.host ?? baseConfig.host;
        }
      }
    }

    if (!enabled) {
      return { ssl: false, secrets };
    }

    if (merged.rejectUnauthorized === undefined) {
      merged.rejectUnauthorized = true;
    } else if (typeof merged.rejectUnauthorized === 'string') {
      merged.rejectUnauthorized = !['false', '0', 'no'].includes(merged.rejectUnauthorized.toLowerCase());
    }

    return {
      ssl: {
        enabled: true,
        mode: merged.mode,
        rejectUnauthorized: merged.rejectUnauthorized,
        servername: merged.servername,
      },
      secrets,
    };
  }

  buildSslConfig(profile) {
    const ssl = profile.ssl;
    if (!ssl || ssl === false) {
      return undefined;
    }

    if (ssl.enabled === false) {
      return undefined;
    }

    const config = {};

    const rejectUnauthorized = ssl.rejectUnauthorized;
    if (rejectUnauthorized !== undefined) {
      config.rejectUnauthorized = !!rejectUnauthorized;
    }

    if (ssl.servername) {
      config.servername = ssl.servername;
    }

    if (profile.ssl_ca) {
      config.ca = profile.ssl_ca;
    }

    if (profile.ssl_cert) {
      config.cert = profile.ssl_cert;
    }

    if (profile.ssl_key) {
      config.key = profile.ssl_key;
    }

    if (profile.ssl_passphrase) {
      config.passphrase = profile.ssl_passphrase;
    }

    if (Object.keys(config).length === 0) {
      return true;
    }

    return config;
  }

  async getPool(profileName) {
    if (this.pools.has(profileName)) {
      return this.pools.get(profileName);
    }

    const profile = await this.profileService.getProfile(profileName, 'postgresql');
    const pool = new Pool(this.buildPoolConfig(profile));

    pool.on('error', (error) => {
      this.logger.warn('PostgreSQL pool error, recreating on next query', {
        profile: profileName,
        error: error.message,
      });
      this.pools.delete(profileName);
    });

    this.pools.set(profileName, pool);
    this.stats.pools += 1;
    return pool;
  }

  async testConnection(profile) {
    const pool = new Pool({ ...this.buildPoolConfig(profile), max: 1 });

    try {
      const client = await pool.connect();
      await client.query('SELECT 1');
      client.release();
    } finally {
      await pool.end();
    }
  }

  decorateSelect(sql, limit) {
    const trimmed = sql.trim();
    if (/^select\s/i.test(trimmed) && !/limit\s+\d+/i.test(trimmed)) {
      return `${trimmed} LIMIT ${limit}`;
    }
    return trimmed;
  }

  async executeQuery(profileName, sql, limit, params) {
    const text = this.validation.ensureSql(sql);
    const safeLimit = this.validation.ensureLimit(limit);
    const queryText = this.decorateSelect(text, safeLimit);
    const values = Array.isArray(params) ? params : undefined;

    try {
      const pool = await this.getPool(profileName);
      const result = values ? await pool.query(queryText, values) : await pool.query(queryText);
      this.stats.queries += 1;
      return {
        success: true,
        command: result.command,
        rowCount: result.rowCount,
        rows: result.rows,
        fields: result.fields?.map((f) => ({ name: f.name, dataTypeId: f.dataTypeID })),
      };
    } catch (error) {
      this.stats.errors += 1;
      this.logger.error('Query failed', { profile: profileName, error: error.message });
      throw error;
    }
  }

  async showTables(profileName) {
    const sql = `
      SELECT schemaname AS schema,
             tablename AS name,
             tableowner AS owner,
             hasindexes,
             hasrules,
             hastriggers
      FROM pg_tables
      WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
      ORDER BY schemaname, tablename
    `;
    return this.executeQuery(profileName, sql);
  }

  async describeTable(profileName, tableName) {
    const name = this.validation.ensureTableName(tableName);
    const pool = await this.getPool(profileName);
    const result = await pool.query(
      `SELECT column_name,
              data_type,
              is_nullable,
              column_default,
              character_maximum_length,
              numeric_precision,
              numeric_scale
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1
       ORDER BY ordinal_position`,
      [name]
    );

    this.stats.queries += 1;
    return { success: true, table: name, columns: result.rows };
  }

  async sampleData(profileName, tableName, limit) {
    const name = this.validation.ensureTableName(tableName);
    const safeLimit = this.validation.ensureLimit(limit, Constants.LIMITS.SAMPLE_DATA_LIMIT);
    const pool = await this.getPool(profileName);
    const sql = `SELECT * FROM ${name} LIMIT $1`;
    const result = await pool.query(sql, [safeLimit]);
    this.stats.queries += 1;
    return { success: true, table: name, sample_size: result.rowCount, rows: result.rows };
  }

  async insertData(profileName, tableName, data) {
    const name = this.validation.ensureTableName(tableName);
    const payload = this.validation.ensureDataObject(data);

    const columns = Object.keys(payload);
    const values = Object.values(payload);
    const placeholders = columns.map((_, index) => `$${index + 1}`);
    const sql = `INSERT INTO ${name} (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`;

    const pool = await this.getPool(profileName);
    const result = await pool.query(sql, values);
    this.stats.queries += 1;
    return { success: true, table: name, row: result.rows[0], rowCount: result.rowCount };
  }

  async updateData(profileName, tableName, data, where) {
    const name = this.validation.ensureTableName(tableName);
    const payload = this.validation.ensureDataObject(data);
    const whereClause = this.validation.ensureWhereClause(where);

    const columns = Object.keys(payload);
    const values = Object.values(payload);
    const assignments = columns.map((col, index) => `${col} = $${index + 1}`);
    const sql = `UPDATE ${name} SET ${assignments.join(', ')} WHERE ${whereClause} RETURNING *`;

    const pool = await this.getPool(profileName);
    const result = await pool.query(sql, values);
    this.stats.queries += 1;
    return { success: true, table: name, rows: result.rows, rowCount: result.rowCount };
  }

  async deleteData(profileName, tableName, where) {
    const name = this.validation.ensureTableName(tableName);
    const whereClause = this.validation.ensureWhereClause(where);

    const sql = `DELETE FROM ${name} WHERE ${whereClause}`;
    const pool = await this.getPool(profileName);
    const result = await pool.query(sql);
    this.stats.queries += 1;
    return { success: true, table: name, rowCount: result.rowCount };
  }

  async databaseInfo(profileName) {
    const sql = `SELECT current_database() AS database_name,
                        current_user AS current_user,
                        version() AS version,
                        pg_size_pretty(pg_database_size(current_database())) AS size`;
    return this.executeQuery(profileName, sql);
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
