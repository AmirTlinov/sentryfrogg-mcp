#!/usr/bin/env node
// @ts-nocheck

/**
 * 🗂️ File-backed cache for HTTP and pipelines.
 */

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { createWriteStream } = require('fs');
const { resolveCacheDir } = require('../utils/paths');
const { atomicReplaceFile, atomicWriteTextFile, tempSiblingPath } = require('../utils/fsAtomic');

class CacheService {
  constructor(logger) {
    this.logger = logger.child('cache');
    this.cacheDir = resolveCacheDir();
    this.stats = {
      hits: 0,
      misses: 0,
      writes: 0,
      errors: 0,
    };
  }

  ensureKey(key) {
    const normalized = typeof key === 'string' ? key.trim().toLowerCase() : '';
    if (!/^[a-f0-9]{64}$/.test(normalized)) {
      throw new Error('Cache key must be a sha256 hex string');
    }
    return normalized;
  }

  normalizeKey(key) {
    if (key === undefined || key === null || key === '') {
      return null;
    }

    if (typeof key === 'string') {
      const trimmed = key.trim();
      if (!trimmed) {
        return null;
      }
      if (/^[a-f0-9]{64}$/i.test(trimmed)) {
        return trimmed.toLowerCase();
      }
      return this.buildKey(trimmed);
    }

    return this.buildKey(key);
  }

  buildKey(input) {
    const payload = this.stableStringify(input);
    return crypto.createHash('sha256').update(payload).digest('hex');
  }

  stableStringify(value) {
    if (value === null || value === undefined) {
      return String(value);
    }
    if (typeof value !== 'object') {
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
      return `[${value.map((item) => this.stableStringify(item)).join(',')}]`;
    }
    const keys = Object.keys(value).sort();
    const items = keys.map((key) => `${JSON.stringify(key)}:${this.stableStringify(value[key])}`);
    return `{${items.join(',')}}`;
  }

  entryPath(key) {
    const normalized = this.ensureKey(key);
    return path.join(this.cacheDir, `${normalized}.json`);
  }

  dataPath(key) {
    const normalized = this.ensureKey(key);
    return path.join(this.cacheDir, `${normalized}.bin`);
  }

  isExpired(meta, ttlOverride) {
    const ttl = ttlOverride ?? meta.ttl_ms;
    if (!ttl || !meta.created_at) {
      return false;
    }
    const created = Date.parse(meta.created_at);
    if (Number.isNaN(created)) {
      return false;
    }
    return Date.now() - created > ttl;
  }

  async getJson(key, ttlMs) {
    try {
      const raw = await fs.readFile(this.entryPath(key), 'utf8');
      const payload = JSON.parse(raw);
      if (payload?.type !== 'json') {
        this.stats.misses += 1;
        return null;
      }
      if (this.isExpired(payload, ttlMs)) {
        await this.remove(key);
        this.stats.misses += 1;
        return null;
      }
      this.stats.hits += 1;
      return payload;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.stats.errors += 1;
        this.logger.warn('Cache read failed', { error: error.message });
      }
      this.stats.misses += 1;
      return null;
    }
  }

  async getFile(key, ttlMs) {
    try {
      const raw = await fs.readFile(this.entryPath(key), 'utf8');
      const payload = JSON.parse(raw);
      if (payload?.type !== 'file') {
        this.stats.misses += 1;
        return null;
      }
      if (this.isExpired(payload, ttlMs)) {
        await this.remove(key);
        this.stats.misses += 1;
        return null;
      }
      this.stats.hits += 1;
      return { ...payload, file_path: this.dataPath(key) };
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.stats.errors += 1;
        this.logger.warn('Cache read failed', { error: error.message });
      }
      this.stats.misses += 1;
      return null;
    }
  }

  async setJson(key, value, meta = {}) {
    const payload = {
      type: 'json',
      created_at: new Date().toISOString(),
      ttl_ms: meta.ttl_ms,
      meta: meta.meta,
      value,
    };
    await atomicWriteTextFile(this.entryPath(key), `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    this.stats.writes += 1;
    return payload;
  }

  async createFileWriter(key, meta = {}) {
    key = this.ensureKey(key);
    await fs.mkdir(this.cacheDir, { recursive: true, mode: 0o700 });
    const tmpPath = tempSiblingPath(this.dataPath(key), '.part');
    const stream = createWriteStream(tmpPath, { mode: 0o600 });

    const finalize = async () => {
      await atomicReplaceFile(tmpPath, this.dataPath(key), { overwrite: true, mode: 0o600 });
      const payload = {
        type: 'file',
        created_at: new Date().toISOString(),
        ttl_ms: meta.ttl_ms,
        meta: meta.meta,
      };
      await atomicWriteTextFile(this.entryPath(key), `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
      this.stats.writes += 1;
      return payload;
    };

    const abort = async () => {
      try {
        await fs.unlink(tmpPath);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          this.logger.warn('Cache cleanup failed', { error: error.message });
        }
      }
    };

    return { stream, finalize, abort, temp_path: tmpPath };
  }

  async remove(key) {
    try {
      await fs.unlink(this.entryPath(key));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
    try {
      await fs.unlink(this.dataPath(key));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  getStats() {
    return { ...this.stats };
  }

  async cleanup() {
    return;
  }
}

module.exports = CacheService;
