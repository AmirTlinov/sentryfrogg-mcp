#!/usr/bin/env node
// @ts-nocheck

const fsSync = require('node:fs');

const { atomicWriteTextFile } = require('../utils/fsAtomic');
const { resolveJobsPath } = require('../utils/paths');

const MemoryJobStore = require('./MemoryJobStore');

function readPositiveInt(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue <= 0) {
    return null;
  }
  return Math.floor(numberValue);
}

class FileJobStore extends MemoryJobStore {
  constructor(logger, { filePath, debounceMs, maxJobs, ttlMs } = {}) {
    super(logger, { maxJobs, ttlMs, source: 'file' });
    this.filePath = filePath || resolveJobsPath();
    this.debounceMs = readPositiveInt(
      debounceMs
      ?? process.env.SENTRYFROGG_JOBS_PERSIST_DEBOUNCE_MS
      ?? process.env.SF_JOBS_PERSIST_DEBOUNCE_MS
    ) ?? 50;
    this.queue = Promise.resolve();
    this.dirty = false;
    this.persistTimer = null;

    this.loadFromDisk();
  }

  loadFromDisk() {
    try {
      if (!fsSync.existsSync(this.filePath)) {
        return;
      }
      const raw = fsSync.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.load(parsed);
        return;
      }
      if (parsed && typeof parsed === 'object') {
        if (Array.isArray(parsed.jobs)) {
          this.load(parsed.jobs);
          return;
        }
        const values = Object.values(parsed);
        if (values.length && values.every((item) => item && typeof item === 'object')) {
          this.load(values);
        }
      }
    } catch (error) {
      this.logger?.warn?.('Failed to load jobs store', { error: error.message });
    }
  }

  onMutate() {
    this.schedulePersist();
  }

  schedulePersist() {
    this.dirty = true;
    if (this.persistTimer) {
      return;
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.flush();
    }, this.debounceMs);
  }

  async flush() {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }

    if (!this.dirty) {
      return this.queue;
    }
    this.dirty = false;

    const payload = `${JSON.stringify(this.toJSON(), null, 2)}\n`;
    this.queue = this.queue
      .then(() => atomicWriteTextFile(this.filePath, payload, { mode: 0o600 }))
      .catch((error) => {
        this.logger?.warn?.('Failed to persist jobs store', { error: error.message });
      });
    return this.queue;
  }
}

module.exports = FileJobStore;
