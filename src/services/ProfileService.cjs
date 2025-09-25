#!/usr/bin/env node

/**
 * 👤 Управление профилями подключения (PostgreSQL, SSH, HTTP)
 */

const fs = require('fs/promises');
const path = require('path');

class ProfileService {
  constructor(logger, security) {
    this.logger = logger.child('profiles');
    this.security = security;
    this.filePath = path.join(process.cwd(), 'profiles.json');
    this.profiles = new Map();
    this.secretFields = ['password', 'private_key', 'passphrase', 'token', 'ssl_ca', 'ssl_cert', 'ssl_key', 'ssl_passphrase'];
    this.stats = {
      created: 0,
      updated: 0,
      loaded: 0,
      saved: 0,
      errors: 0,
    };

    this.initPromise = this.loadProfiles();
  }

  async initialize() {
    await this.initPromise;
  }

  async loadProfiles() {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      for (const [name, profile] of Object.entries(parsed)) {
        this.profiles.set(name, profile);
      }
      this.stats.loaded = this.profiles.size;
      this.logger.info('Profiles loaded', { count: this.profiles.size });
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.logger.info('profiles.json not found, starting clean');
        return;
      }
      this.stats.errors += 1;
      this.logger.error('Failed to load profiles', { error: error.message });
      throw error;
    }
  }

  async persist() {
    const data = Object.fromEntries(this.profiles);
    await fs.writeFile(this.filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    this.stats.saved += 1;
  }

  async ensureReady() {
    await this.initPromise;
  }

  async setProfile(name, config) {
    await this.ensureReady();

    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new Error('Profile name must be a non-empty string');
    }

    if (typeof config !== 'object' || config === null) {
      throw new Error('Profile config must be an object');
    }

    const trimmedName = name.trim();
    const existing = this.profiles.get(trimmedName) || {};

    const profile = {
      type: config.type || existing.type,
      host: config.host ?? existing.host,
      port: config.port ?? existing.port,
      username: config.username ?? existing.username,
      database: config.database ?? existing.database,
      ssl: config.ssl ?? existing.ssl,
      options: config.options ?? existing.options,
      created_at: existing.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    if (!profile.type) {
      throw new Error('Profile type must be specified');
    }

    const encryptedSecrets = {};
    for (const field of this.secretFields) {
      if (config[field]) {
        encryptedSecrets[field] = await this.security.encrypt(config[field]);
      } else if (existing.secrets?.[field]) {
        encryptedSecrets[field] = existing.secrets[field];
      } else if (existing[field]) {
        // legacy формат, мигрируем
        encryptedSecrets[field] = existing[field];
      }
    }

    if (Object.keys(encryptedSecrets).length > 0) {
      profile.secrets = encryptedSecrets;
    }

    this.profiles.set(trimmedName, profile);
    await this.persist();

    if (existing.created_at) {
      this.stats.updated += 1;
    } else {
      this.stats.created += 1;
    }

    this.logger.info('Profile saved', { name: trimmedName, type: profile.type });

    return {
      name: trimmedName,
      type: profile.type,
      host: profile.host,
      port: profile.port,
      username: profile.username,
      database: profile.database,
      ssl: profile.ssl,
    };
  }

  async getProfile(name, expectedType) {
    await this.ensureReady();

    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new Error('Profile name must be a non-empty string');
    }

    const key = name.trim();
    const entry = this.profiles.get(key);
    if (!entry) {
      throw new Error(`Profile '${name}' not found`);
    }

    if (expectedType && entry.type !== expectedType) {
      throw new Error(`Profile '${name}' is of type '${entry.type}', expected '${expectedType}'`);
    }

    const result = {
      name: key,
      type: entry.type,
      host: entry.host,
      port: entry.port,
      username: entry.username,
      database: entry.database,
      ssl: entry.ssl,
      options: entry.options,
    };

    if (entry.secrets) {
      for (const [field, value] of Object.entries(entry.secrets)) {
        try {
          result[field] = await this.security.decrypt(value);
        } catch (error) {
          this.logger.warn('Failed to decrypt profile field', { name: key, field, error: error.message });
        }
      }
    } else if (entry.password && entry.encrypted !== false) {
      result.password = await this.security.decrypt(entry.password);
    } else if (entry.password) {
      result.password = entry.password;
    }

    return result;
  }

  async listProfiles(type) {
    await this.ensureReady();

    const items = [];
    for (const [name, profile] of this.profiles.entries()) {
      if (type && profile.type !== type) {
        continue;
      }
      items.push({
        name,
        type: profile.type,
        host: profile.host,
        port: profile.port,
        username: profile.username,
        database: profile.database,
        ssl: profile.ssl,
        created_at: profile.created_at,
        updated_at: profile.updated_at,
      });
    }

    return items;
  }

  async deleteProfile(name) {
    await this.ensureReady();
    if (!this.profiles.delete(name)) {
      throw new Error(`Profile '${name}' not found`);
    }
    await this.persist();
    this.logger.info('Profile deleted', { name });
    return { success: true };
  }

  hasProfile(name) {
    return this.profiles.has(name);
  }

  getStats() {
    return { ...this.stats, total: this.profiles.size };
  }

  async cleanup() {
    this.profiles.clear();
  }
}

module.exports = ProfileService;
