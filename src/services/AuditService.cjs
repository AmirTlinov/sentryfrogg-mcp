#!/usr/bin/env node

/**
 * 🧾 Audit log service (JSONL).
 */

const fs = require('fs/promises');
const { createReadStream } = require('fs');
const path = require('path');
const readline = require('readline');
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
      await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      await fs.appendFile(this.filePath, payload, { encoding: 'utf8', mode: 0o600 });
      try {
        await fs.chmod(this.filePath, 0o600);
      } catch (error) {
        // Best-effort (Windows/FS policies).
      }
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

  buildFilter(filters = {}) {
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

    const matches = (entry) => {
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
      if (sinceTime) {
        const ts = Date.parse(entry.timestamp);
        if (!Number.isNaN(ts) && ts < sinceTime) {
          return false;
        }
      }
      return true;
    };

    return { normalized, sinceTime, matches };
  }

  async readEntries({ limit = 100, offset = 0, reverse = false, filters = {} } = {}) {
    const safeLimit = Number.isInteger(limit) ? Math.max(0, limit) : 100;
    const safeOffset = Number.isInteger(offset) ? Math.max(0, offset) : 0;
    const bufferSize = reverse ? safeLimit + safeOffset : 0;
    const { matches } = this.buildFilter(filters);

    let total = 0;
    const collected = [];

    try {
      const stream = createReadStream(this.filePath, { encoding: 'utf8' });
      try {
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
        for await (const line of rl) {
          const trimmed = line.trim();
          if (!trimmed) {
            continue;
          }
          let entry;
          try {
            entry = JSON.parse(trimmed);
          } catch (error) {
            this.logger.warn('Skipping invalid audit entry', { error: error.message });
            continue;
          }
          if (!matches(entry)) {
            continue;
          }

          total += 1;

          if (reverse) {
            if (bufferSize > 0) {
              collected.push(entry);
              if (collected.length > bufferSize) {
                collected.shift();
              }
            }
            continue;
          }

          const index = total - 1;
          if (index >= safeOffset && collected.length < safeLimit) {
            collected.push(entry);
          }
        }
      } finally {
        stream.destroy();
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }

    let entries = collected;
    if (reverse) {
      entries = collected.slice().reverse().slice(safeOffset, safeOffset + safeLimit);
    }

    this.stats.reads += 1;
    return { success: true, total, offset: safeOffset, limit: safeLimit, entries };
  }

  getStats() {
    return { ...this.stats };
  }

  async cleanup() {
    return;
  }
}

module.exports = AuditService;
