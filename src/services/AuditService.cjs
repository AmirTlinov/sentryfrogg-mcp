#!/usr/bin/env node

/**
 * 🧾 Audit log service (JSONL).
 */

const fs = require('fs/promises');
const path = require('path');
const { resolveAuditPath } = require('../utils/paths.cjs');

class AuditService {
  constructor(logger) {
    this.logger = logger.child('audit');
    this.filePath = resolveAuditPath();
    this.stats = {
      logged: 0,
      errors: 0,
      reads: 0,
      cleared: 0,
    };
    this.queue = Promise.resolve();
  }

  async append(entry) {
    const payload = `${JSON.stringify(entry)}\n`;
    const write = async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.appendFile(this.filePath, payload, 'utf8');
      this.stats.logged += 1;
    };

    this.queue = this.queue.then(write).catch((error) => {
      this.stats.errors += 1;
      this.logger.warn('Audit write failed', { error: error.message });
    });

    return this.queue;
  }

  async clear() {
    try {
      await fs.unlink(this.filePath);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
    this.stats.cleared += 1;
    return { success: true };
  }

  parseEntries(raw) {
    const entries = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        const parsed = JSON.parse(line);
        entries.push(parsed);
      } catch (error) {
        this.logger.warn('Skipping invalid audit entry', { error: error.message });
      }
    }
    return entries;
  }

  filterEntries(entries, filters = {}) {
    const normalized = {
      trace_id: filters.trace_id,
      tool: filters.tool,
      action: filters.action,
      status: filters.status,
      since: filters.since,
    };

    let sinceTime = null;
    if (normalized.since) {
      const parsed = Date.parse(normalized.since);
      if (!Number.isNaN(parsed)) {
        sinceTime = parsed;
      }
    }

    return entries.filter((entry) => {
      if (normalized.trace_id && entry.trace_id !== normalized.trace_id) {
        return false;
      }
      if (normalized.tool && entry.tool !== normalized.tool) {
        return false;
      }
      if (normalized.action && entry.action !== normalized.action) {
        return false;
      }
      if (normalized.status && entry.status !== normalized.status) {
        return false;
      }
      if (sinceTime && Date.parse(entry.timestamp) < sinceTime) {
        return false;
      }
      return true;
    });
  }

  async readEntries({ limit = 100, offset = 0, reverse = false, filters = {} } = {}) {
    let raw = '';
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }

    let entries = this.parseEntries(raw);
    entries = this.filterEntries(entries, filters);

    if (reverse) {
      entries = entries.reverse();
    }

    const total = entries.length;
    const sliced = entries.slice(offset, offset + limit);

    this.stats.reads += 1;
    return { success: true, total, offset, limit, entries: sliced };
  }

  getStats() {
    return { ...this.stats };
  }

  async cleanup() {
    return;
  }
}

module.exports = AuditService;
