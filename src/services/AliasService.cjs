#!/usr/bin/env node

/**
 * 🧩 Alias storage (JSON file).
 */

const fs = require('fs/promises');
const { resolveAliasesPath } = require('../utils/paths.cjs');
const { atomicWriteTextFile } = require('../utils/fsAtomic.cjs');

class AliasService {
  constructor(logger) {
    this.logger = logger.child('aliases');
    this.filePath = resolveAliasesPath();
    this.aliases = new Map();
    this.stats = {
      loaded: 0,
      saved: 0,
      created: 0,
      updated: 0,
    };
    this.initPromise = this.load();
  }

  async initialize() {
    await this.initPromise;
  }

  async load() {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      for (const [name, alias] of Object.entries(parsed || {})) {
        this.aliases.set(name, alias);
      }
      this.stats.loaded = this.aliases.size;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.logger.warn('Failed to load aliases file', { error: error.message });
      }
    }
  }

  async persist() {
    const data = Object.fromEntries(this.aliases);
    await atomicWriteTextFile(this.filePath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    this.stats.saved += 1;
  }

  async ensureReady() {
    await this.initPromise;
  }

  validateAlias(alias) {
    if (!alias || typeof alias !== 'object' || Array.isArray(alias)) {
      throw new Error('alias must be an object');
    }
    if (!alias.tool || typeof alias.tool !== 'string' || alias.tool.trim().length === 0) {
      throw new Error('alias.tool must be a non-empty string');
    }
    if (alias.args !== undefined) {
      if (typeof alias.args !== 'object' || alias.args === null || Array.isArray(alias.args)) {
        throw new Error('alias.args must be an object');
      }
    }
  }

  async setAlias(name, alias) {
    await this.ensureReady();
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new Error('alias name must be a non-empty string');
    }
    this.validateAlias(alias);

    const trimmed = name.trim();
    const existing = this.aliases.get(trimmed);

    const payload = {
      ...alias,
      updated_at: new Date().toISOString(),
      created_at: existing?.created_at || new Date().toISOString(),
    };

    this.aliases.set(trimmed, payload);
    await this.persist();

    if (existing) {
      this.stats.updated += 1;
    } else {
      this.stats.created += 1;
    }

    return { success: true, alias: { name: trimmed, ...payload } };
  }

  async getAlias(name) {
    await this.ensureReady();
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new Error('alias name must be a non-empty string');
    }
    const trimmed = name.trim();
    const entry = this.aliases.get(trimmed);
    if (!entry) {
      throw new Error(`alias '${trimmed}' not found`);
    }
    return { success: true, alias: { name: trimmed, ...entry } };
  }

  async listAliases() {
    await this.ensureReady();
    const items = [];
    for (const [name, alias] of this.aliases.entries()) {
      items.push({
        name,
        tool: alias.tool,
        description: alias.description,
        created_at: alias.created_at,
        updated_at: alias.updated_at,
      });
    }
    return { success: true, aliases: items };
  }

  async deleteAlias(name) {
    await this.ensureReady();
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new Error('alias name must be a non-empty string');
    }
    const trimmed = name.trim();
    if (!this.aliases.delete(trimmed)) {
      throw new Error(`alias '${trimmed}' not found`);
    }
    await this.persist();
    return { success: true, alias: trimmed };
  }

  async resolveAlias(name) {
    await this.ensureReady();
    if (!name || typeof name !== 'string') {
      return null;
    }
    return this.aliases.get(name) || null;
  }

  getStats() {
    return { ...this.stats, total: this.aliases.size };
  }

  async cleanup() {
    this.aliases.clear();
  }
}

module.exports = AliasService;
