#!/usr/bin/env node

/**
 * 📚 Runbook storage (JSON file).
 */

const fs = require('fs/promises');
const path = require('path');
const { resolveRunbooksPath } = require('../utils/paths.cjs');

class RunbookService {
  constructor(logger) {
    this.logger = logger.child('runbooks');
    this.filePath = resolveRunbooksPath();
    this.runbooks = new Map();
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
      for (const [name, runbook] of Object.entries(parsed || {})) {
        this.runbooks.set(name, runbook);
      }
      this.stats.loaded = this.runbooks.size;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.logger.warn('Failed to load runbooks file', { error: error.message });
      }
    }
  }

  async persist() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const data = Object.fromEntries(this.runbooks);
    await fs.writeFile(this.filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    this.stats.saved += 1;
  }

  async ensureReady() {
    await this.initPromise;
  }

  validateRunbook(runbook) {
    if (!runbook || typeof runbook !== 'object' || Array.isArray(runbook)) {
      throw new Error('runbook must be an object');
    }
    if (!Array.isArray(runbook.steps) || runbook.steps.length === 0) {
      throw new Error('runbook.steps must be a non-empty array');
    }
  }

  async setRunbook(name, runbook) {
    await this.ensureReady();
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new Error('runbook name must be a non-empty string');
    }
    this.validateRunbook(runbook);

    const trimmed = name.trim();
    const existing = this.runbooks.get(trimmed);
    const payload = {
      ...runbook,
      updated_at: new Date().toISOString(),
      created_at: existing?.created_at || new Date().toISOString(),
    };

    this.runbooks.set(trimmed, payload);
    await this.persist();

    if (existing) {
      this.stats.updated += 1;
    } else {
      this.stats.created += 1;
    }

    return { success: true, runbook: { name: trimmed, ...payload } };
  }

  async getRunbook(name) {
    await this.ensureReady();
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new Error('runbook name must be a non-empty string');
    }
    const trimmed = name.trim();
    const entry = this.runbooks.get(trimmed);
    if (!entry) {
      throw new Error(`runbook '${trimmed}' not found`);
    }
    return { success: true, runbook: { name: trimmed, ...entry } };
  }

  async listRunbooks() {
    await this.ensureReady();
    const items = [];
    for (const [name, runbook] of this.runbooks.entries()) {
      items.push({
        name,
        description: runbook.description,
        steps: Array.isArray(runbook.steps) ? runbook.steps.length : 0,
        created_at: runbook.created_at,
        updated_at: runbook.updated_at,
      });
    }
    return { success: true, runbooks: items };
  }

  async deleteRunbook(name) {
    await this.ensureReady();
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new Error('runbook name must be a non-empty string');
    }
    const trimmed = name.trim();
    if (!this.runbooks.delete(trimmed)) {
      throw new Error(`runbook '${trimmed}' not found`);
    }
    await this.persist();
    return { success: true, runbook: trimmed };
  }

  getStats() {
    return { ...this.stats, total: this.runbooks.size };
  }

  async cleanup() {
    this.runbooks.clear();
  }
}

module.exports = RunbookService;
