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
        ssl: params.ssl === 'true' || params.sslmode === 'require' ? true : undefined,
      };
    } catch (error) {
      throw new Error(`Failed to parse connection_url: ${error.message}`);
    }
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

    const finalProfile = {
      ...validated,
      ssl: params.ssl ?? baseConfig.ssl ?? false,
      type: 'postgresql',
    };

    if (params.connection_url) {
      finalProfile.connection_url = params.connection_url;
    }

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
      ssl: profile.ssl ? { rejectUnauthorized: false } : undefined,
    };
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
