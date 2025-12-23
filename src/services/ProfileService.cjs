#!/usr/bin/env node

/**
 * 👤 Управление профилями подключения.
 */

const fs = require('fs/promises');
const path = require('path');
const { resolveProfileBaseDir } = require('../utils/paths.cjs');
const { atomicWriteTextFile } = require('../utils/fsAtomic.cjs');

class ProfileService {
  constructor(logger, security) {
    this.logger = logger.child('profiles');
    this.security = security;
    this.baseDir = resolveProfileBaseDir();
    this.filePath = path.join(this.baseDir, 'profiles.json');
    this.profiles = new Map();
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

  ensurePlainObject(value, label) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`${label} must be an object`);
    }
    return value;
  }

  validateStoredProfile(name, profile) {
    if (!profile || typeof profile !== 'object') {
      throw new Error(`Profile '${name}' has invalid format`);
    }
    if (typeof profile.type !== 'string' || profile.type.trim().length === 0) {
      throw new Error(`Profile '${name}' is missing type`);
    }
    if (profile.data && (typeof profile.data !== 'object' || Array.isArray(profile.data))) {
      throw new Error(`Profile '${name}' has invalid data section`);
    }
    if (profile.secrets && (typeof profile.secrets !== 'object' || Array.isArray(profile.secrets))) {
      throw new Error(`Profile '${name}' has invalid secrets section`);
    }
  }

  async loadProfiles() {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      for (const [name, profile] of Object.entries(parsed)) {
        this.validateStoredProfile(name, profile);
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
    await atomicWriteTextFile(this.filePath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    this.stats.saved += 1;
  }

  async ensureReady() {
    await this.initPromise;
  }

  async encryptSecret(value, label) {
    if (value === undefined) {
      return undefined;
    }
    if (value === null || value === '') {
      return null;
    }
    if (typeof value !== 'string') {
      throw new Error(`${label} must be a string`);
    }
    return this.security.encrypt(value);
  }

  async setProfile(name, config) {
    await this.ensureReady();

    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new Error('Profile name must be a non-empty string');
    }

    this.ensurePlainObject(config, 'Profile config');

    const trimmedName = name.trim();
    const existing = this.profiles.get(trimmedName) || {};
    const incomingData = config.data ? this.ensurePlainObject(config.data, 'Profile data') : undefined;

    const profile = {
      type: config.type || existing.type,
      data: { ...(existing.data || {}) },
      created_at: existing.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    if (!profile.type) {
      throw new Error('Profile type must be specified');
    }

    if (incomingData) {
      for (const [key, value] of Object.entries(incomingData)) {
        if (value === undefined) {
          continue;
        }
        profile.data[key] = value;
      }
    }

    let secrets = existing.secrets ? { ...existing.secrets } : {};
    if (config.secrets === null) {
      secrets = {};
    } else if (config.secrets !== undefined) {
      const incomingSecrets = this.ensurePlainObject(config.secrets, 'Profile secrets');
      for (const [key, rawValue] of Object.entries(incomingSecrets)) {
        const encrypted = await this.encryptSecret(rawValue, `Secret '${key}'`);
        if (encrypted === null) {
          delete secrets[key];
        } else if (encrypted !== undefined) {
          secrets[key] = encrypted;
        }
      }
    }

    if (Object.keys(secrets).length > 0) {
      profile.secrets = secrets;
    } else {
      delete profile.secrets;
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
      data: profile.data,
      created_at: profile.created_at,
      updated_at: profile.updated_at,
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
      data: { ...(entry.data || {}) },
    };

    if (entry.secrets) {
      const decrypted = {};
      for (const [field, value] of Object.entries(entry.secrets)) {
        decrypted[field] = await this.security.decrypt(value);
      }
      result.secrets = decrypted;
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
        data: profile.data || {},
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
