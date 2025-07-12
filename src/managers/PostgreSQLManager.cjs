#!/usr/bin/env node

/**
 * 🐘 POSTGRESQL MANAGER
 * Управление PostgreSQL подключениями и запросами с безопасностью
 */

const { Pool } = require('pg');
const Constants = require('../constants/Constants.cjs');

class PostgreSQLManager {
  constructor(logger, security, validation, profileService) {
    this.logger = logger;
    this.security = security;
    this.validation = validation;
    this.profileService = profileService;
    this.pools = new Map();
    this.stats = {
      queries: 0,
      connections: 0,
      errors: 0,
      profiles_created: 0
    };
  }

  // Обработка всех действий PostgreSQL
  async handleAction(args) {
    const { action, profile_name = 'default', ...params } = args;
    
    try {
      this.logger.info('PostgreSQL action requested', { action, profile_name });
      
      switch (action) {
        case 'setup_profile':
          return await this.setupProfile(profile_name, params);
        case 'list_profiles':
          return await this.listProfiles();
        case 'quick_query':
          return await this.executeQuery(profile_name, params.sql, params.limit);
        case 'show_tables':
          return await this.showTables(profile_name);
        case 'describe_table':
          return await this.describeTable(profile_name, params.table_name);
        case 'sample_data':
          return await this.sampleData(profile_name, params.table_name, params.limit);
        case 'insert_data':
          return await this.insertData(profile_name, params.table_name, params.data);
        case 'update_data':
          return await this.updateData(profile_name, params.table_name, params.data, params.where);
        case 'delete_data':
          return await this.deleteData(profile_name, params.table_name, params.where);
        case 'database_info':
          return await this.getDatabaseInfo(profile_name);
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    } catch (error) {
      this.stats.errors++;
      this.logger.error('PostgreSQL action failed', { 
        action, 
        profile_name, 
        error: error.message 
      });
      throw error;
    }
  }

  // Настройка профиля подключения
  async setupProfile(profileName, params) {
    try {
      const { host, port = Constants.NETWORK.POSTGRES_DEFAULT_PORT, username, password, database } = params;
      
      if (!host || !username || !password || !database) {
        throw new Error('Missing required parameters: host, username, password, database');
      }

      const profile = {
        host,
        port: parseInt(port),
        username,
        password,
        database,
        type: 'postgresql'
      };

      // Валидация профиля
      const validation = this.validation.validateConnectionProfile(profile);
      if (!validation.valid) {
        throw new Error(`Profile validation failed: ${validation.errors.join(', ')}`);
      }

      // Тестирование подключения
      await this.testConnection(profile);

      // Сохранение профиля
      await this.profileService.setProfile(profileName, profile);
      
      this.stats.profiles_created++;
      this.logger.info('PostgreSQL profile created', { profileName, host, database });
      
      return {
        success: true,
        message: `PostgreSQL profile '${profileName}' created successfully`,
        profile: { profileName, host, port, username, database }
      };
      
    } catch (error) {
      this.logger.error('Failed to setup PostgreSQL profile', { 
        profileName, 
        error: error.message 
      });
      throw error;
    }
  }

  // Список профилей
  async listProfiles() {
    try {
      const profiles = await this.profileService.listProfiles();
      const postgresProfiles = profiles.filter(p => p.type === 'postgresql');
      
      this.logger.debug('PostgreSQL profiles listed', { count: postgresProfiles.length });
      
      return {
        success: true,
        profiles: postgresProfiles
      };
      
    } catch (error) {
      this.logger.error('Failed to list PostgreSQL profiles', { error: error.message });
      throw error;
    }
  }

  // Получение пула подключений
  async getPool(profileName) {
    if (this.pools.has(profileName)) {
      return this.pools.get(profileName);
    }

    const profile = await this.profileService.getProfile(profileName);
    
    const pool = new Pool({
      host: profile.host,
      port: profile.port,
      user: profile.username,
      password: profile.password,
      database: profile.database,
      max: Constants.LIMITS.MAX_CONNECTIONS,
      idleTimeoutMillis: Constants.TIMEOUTS.IDLE_TIMEOUT,
      connectionTimeoutMillis: Constants.TIMEOUTS.CONNECTION_TIMEOUT,
    });

    // Обработка ошибок пула
    pool.on('error', (err) => {
      this.logger.error('PostgreSQL pool error', { 
        profileName, 
        error: err.message 
      });
      this.pools.delete(profileName);
    });

    this.pools.set(profileName, pool);
    this.stats.connections++;
    
    return pool;
  }

  // Тестирование подключения
  async testConnection(profile) {
    const pool = new Pool({
      host: profile.host,
      port: profile.port,
      user: profile.username,
      password: profile.password,
      database: profile.database,
      max: 1,
      connectionTimeoutMillis: Constants.TIMEOUTS.CONNECTION_TIMEOUT,
    });

    try {
      const client = await pool.connect();
      await client.query('SELECT 1');
      client.release();
      await pool.end();
      
      this.logger.debug('PostgreSQL connection test successful', { 
        host: profile.host, 
        database: profile.database 
      });
      
    } catch (error) {
      await pool.end();
      throw new Error(`Connection test failed: ${error.message}`);
    }
  }

  // Выполнение SQL запроса
  async executeQuery(profileName, sql, limit = Constants.LIMITS.DEFAULT_QUERY_LIMIT) {
    try {
      if (!sql || typeof sql !== 'string') {
        throw new Error('SQL query is required');
      }

      // Валидация SQL
      const validation = this.validation.validateSqlQuery(sql);
      if (!validation.valid) {
        throw new Error(`SQL validation failed: ${validation.errors.join(', ')}`);
      }

      // Валидация лимита
      const limitValidation = this.validation.validateLimit(limit);
      if (!limitValidation.valid) {
        throw new Error(`Limit validation failed: ${limitValidation.errors.join(', ')}`);
      }

      const pool = await this.getPool(profileName);
      
      // Добавление LIMIT для SELECT запросов
      let finalSql = sql;
      if (sql.toUpperCase().trim().startsWith('SELECT') && !sql.toUpperCase().includes('LIMIT')) {
        // Нормализация SQL: убираем переносы строк и точки с запятой в конце
        const normalizedSql = sql.trim().replace(/\s+/g, ' ').replace(/;$/, '');
        finalSql = `${normalizedSql} LIMIT ${limit}`;
      }

      const result = await pool.query(finalSql);
      this.stats.queries++;
      
      this.logger.info('PostgreSQL query executed', { 
        profileName, 
        rowCount: result.rowCount,
        command: result.command 
      });
      
      return {
        success: true,
        command: result.command,
        rowCount: result.rowCount,
        rows: result.rows,
        fields: result.fields?.map(f => ({ name: f.name, type: f.dataTypeID })) || []
      };
      
    } catch (error) {
      this.logger.error('PostgreSQL query failed', { 
        profileName, 
        sql: sql?.substring(0, Constants.LIMITS.LOG_SUBSTRING_LENGTH), 
        error: error.message 
      });
      throw error;
    }
  }

  // Показать таблицы
  async showTables(profileName) {
    const sql = `
      SELECT 
        schemaname as schema,
        tablename as table,
        tableowner as owner,
        hasindexes as has_indexes,
        hasrules as has_rules,
        hastriggers as has_triggers
      FROM pg_tables 
      WHERE schemaname NOT IN ('information_schema', 'pg_catalog')
      ORDER BY schemaname, tablename
    `;
    
    return await this.executeQuery(profileName, sql);
  }

  // Описание таблицы
  async describeTable(profileName, tableName) {
    if (!tableName) {
      throw new Error('Table name is required');
    }

    // Валидация имени таблицы
    const validation = this.validation.validateTableName(tableName);
    if (!validation.valid) {
      throw new Error(`Table name validation failed: ${validation.errors.join(', ')}`);
    }

    const sql = `
      SELECT 
        column_name,
        data_type,
        is_nullable,
        column_default,
        character_maximum_length,
        numeric_precision,
        numeric_scale
      FROM information_schema.columns 
      WHERE table_name = $1
      ORDER BY ordinal_position
    `;
    
    try {
      const pool = await this.getPool(profileName);
      const result = await pool.query(sql, [tableName]);
      
      this.stats.queries++;
      
      return {
        success: true,
        table: tableName,
        columns: result.rows
      };
      
    } catch (error) {
      this.logger.error('Failed to describe table', { 
        profileName, 
        tableName, 
        error: error.message 
      });
      throw error;
    }
  }

  // Получить образец данных
  async sampleData(profileName, tableName, limit = Constants.LIMITS.SAMPLE_DATA_LIMIT) {
    if (!tableName) {
      throw new Error('Table name is required');
    }

    // Валидация имени таблицы
    const validation = this.validation.validateTableName(tableName);
    if (!validation.valid) {
      throw new Error(`Table name validation failed: ${validation.errors.join(', ')}`);
    }

    // Валидация лимита
    const limitValidation = this.validation.validateLimit(limit);
    if (!limitValidation.valid) {
      throw new Error(`Limit validation failed: ${limitValidation.errors.join(', ')}`);
    }

    const sql = `SELECT * FROM ${tableName} LIMIT $1`;
    
    try {
      const pool = await this.getPool(profileName);
      const result = await pool.query(sql, [limit]);
      
      this.stats.queries++;
      
      return {
        success: true,
        table: tableName,
        sample_size: result.rows.length,
        data: result.rows
      };
      
    } catch (error) {
      this.logger.error('Failed to get sample data', { 
        profileName, 
        tableName, 
        error: error.message 
      });
      throw error;
    }
  }

  // Вставка данных
  async insertData(profileName, tableName, data) {
    if (!tableName || !data) {
      throw new Error('Table name and data are required');
    }

    // Валидация имени таблицы
    const tableValidation = this.validation.validateTableName(tableName);
    if (!tableValidation.valid) {
      throw new Error(`Table name validation failed: ${tableValidation.errors.join(', ')}`);
    }

    // Валидация данных
    const dataValidation = this.validation.validateInsertData(data);
    if (!dataValidation.valid) {
      throw new Error(`Data validation failed: ${dataValidation.errors.join(', ')}`);
    }

    const columns = Object.keys(data);
    const values = Object.values(data);
    const placeholders = values.map((_, index) => `$${index + 1}`).join(', ');
    
    const sql = `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders}) RETURNING *`;
    
    try {
      const pool = await this.getPool(profileName);
      const result = await pool.query(sql, values);
      
      this.stats.queries++;
      
      return {
        success: true,
        table: tableName,
        inserted: result.rows[0],
        rowCount: result.rowCount
      };
      
    } catch (error) {
      this.logger.error('Failed to insert data', { 
        profileName, 
        tableName, 
        error: error.message 
      });
      throw error;
    }
  }

  // Обновление данных
  async updateData(profileName, tableName, data, where) {
    if (!tableName || !data || !where) {
      throw new Error('Table name, data, and where clause are required');
    }

    // Валидация имени таблицы
    const tableValidation = this.validation.validateTableName(tableName);
    if (!tableValidation.valid) {
      throw new Error(`Table name validation failed: ${tableValidation.errors.join(', ')}`);
    }

    // Валидация данных
    const dataValidation = this.validation.validateInsertData(data);
    if (!dataValidation.valid) {
      throw new Error(`Data validation failed: ${dataValidation.errors.join(', ')}`);
    }

    const columns = Object.keys(data);
    const values = Object.values(data);
    const setClause = columns.map((col, index) => `${col} = $${index + 1}`).join(', ');
    
    const sql = `UPDATE ${tableName} SET ${setClause} WHERE ${where} RETURNING *`;
    
    try {
      const pool = await this.getPool(profileName);
      const result = await pool.query(sql, values);
      
      this.stats.queries++;
      
      return {
        success: true,
        table: tableName,
        updated: result.rows,
        rowCount: result.rowCount
      };
      
    } catch (error) {
      this.logger.error('Failed to update data', { 
        profileName, 
        tableName, 
        error: error.message 
      });
      throw error;
    }
  }

  // Удаление данных
  async deleteData(profileName, tableName, where) {
    if (!tableName || !where) {
      throw new Error('Table name and where clause are required');
    }

    // Валидация имени таблицы
    const tableValidation = this.validation.validateTableName(tableName);
    if (!tableValidation.valid) {
      throw new Error(`Table name validation failed: ${tableValidation.errors.join(', ')}`);
    }

    const sql = `DELETE FROM ${tableName} WHERE ${where}`;
    
    try {
      const pool = await this.getPool(profileName);
      const result = await pool.query(sql);
      
      this.stats.queries++;
      
      return {
        success: true,
        table: tableName,
        deleted: result.rowCount
      };
      
    } catch (error) {
      this.logger.error('Failed to delete data', { 
        profileName, 
        tableName, 
        error: error.message 
      });
      throw error;
    }
  }

  // Информация о базе данных
  async getDatabaseInfo(profileName) {
    const sql = `
      SELECT 
        current_database() as database_name,
        current_user as current_user,
        version() as version,
        pg_size_pretty(pg_database_size(current_database())) as size
    `;
    
    return await this.executeQuery(profileName, sql);
  }

  // Получение статистики
  getStats() {
    return {
      ...this.stats,
      active_pools: this.pools.size
    };
  }

  // Очистка ресурсов
  async cleanup() {
    try {
      for (const [profileName, pool] of this.pools) {
        await pool.end();
        this.logger.debug('PostgreSQL pool closed', { profileName });
      }
      
      this.pools.clear();
      this.logger.info('PostgreSQL manager cleaned up');
      
    } catch (error) {
      this.logger.error('Failed to cleanup PostgreSQL manager', { error: error.message });
      throw error;
    }
  }
}

function createPostgreSQLManager(logger, security, validation, profileService) {
  return new PostgreSQLManager(logger, security, validation, profileService);
}

module.exports = PostgreSQLManager; 