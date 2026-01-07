#!/usr/bin/env node

const crypto = require('node:crypto');

const DEFAULT_MAX_JOBS = 500;
const DEFAULT_TTL_MS = 6 * 60 * 60_000;

const VALID_STATUSES = new Set(['queued', 'running', 'succeeded', 'failed', 'canceled']);

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

function nowIso() {
  return new Date().toISOString();
}

class MemoryJobStore {
  constructor(logger, { maxJobs, ttlMs, source } = {}) {
    this.logger = logger?.child ? logger.child('jobs_store') : logger;
    this.jobs = new Map();

    const maxJobsEnv = process.env.SENTRYFROGG_JOBS_MAX || process.env.SF_JOBS_MAX;
    const ttlEnv = process.env.SENTRYFROGG_JOBS_TTL_MS || process.env.SF_JOBS_TTL_MS;

    this.maxJobs = Number.isFinite(maxJobs) ? Math.floor(maxJobs) : (readPositiveInt(maxJobsEnv) ?? DEFAULT_MAX_JOBS);
    this.ttlMs = Number.isFinite(ttlMs) ? Math.floor(ttlMs) : (readPositiveInt(ttlEnv) ?? DEFAULT_TTL_MS);
    this.source = source || 'memory';
  }

  onMutate() {
    return;
  }

  purgeExpired(now = Date.now()) {
    const removed = [];
    for (const [jobId, job] of this.jobs.entries()) {
      const expiresAt = job?.expires_at_ms;
      if (expiresAt && expiresAt <= now) {
        this.jobs.delete(jobId);
        this.onMutate();
        removed.push(jobId);
      }
    }
    return removed;
  }

  touch(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) {
      return null;
    }
    this.jobs.delete(jobId);
    this.jobs.set(jobId, job);
    return job;
  }

  enforceCapacity() {
    while (this.jobs.size > this.maxJobs) {
      const oldest = this.jobs.keys().next().value;
      if (!oldest) {
        break;
      }
      this.jobs.delete(oldest);
      this.onMutate();
    }
  }

  normalizeStatus(status) {
    const value = status === undefined || status === null ? null : String(status).trim();
    if (!value) {
      return null;
    }
    return VALID_STATUSES.has(value) ? value : null;
  }

  create({ kind, trace_id, parent_span_id, provider, progress } = {}) {
    const jobId = crypto.randomUUID();
    const createdAt = nowIso();
    const record = {
      job_id: jobId,
      kind: kind ? String(kind) : 'inprocess_task',
      status: 'queued',
      trace_id: trace_id || undefined,
      parent_span_id: parent_span_id || undefined,
      created_at: createdAt,
      started_at: null,
      updated_at: createdAt,
      ended_at: null,
      progress: typeof progress === 'number' ? progress : null,
      artifacts: null,
      provider: provider && typeof provider === 'object' && !Array.isArray(provider) ? provider : null,
      error: null,
      expires_at_ms: Date.now() + this.ttlMs,
    };
    this.jobs.set(jobId, record);
    this.onMutate();
    this.enforceCapacity();
    return record;
  }

  upsert(job) {
    if (!job || typeof job !== 'object') {
      return null;
    }
    const jobId = typeof job.job_id === 'string' && job.job_id.trim().length ? job.job_id.trim() : null;
    if (!jobId) {
      return null;
    }

    const existing = this.jobs.get(jobId);
    const createdAt = existing?.created_at || job.created_at || nowIso();
    const updatedAt = nowIso();
    const status = this.normalizeStatus(job.status) || existing?.status || 'queued';

    const next = {
      ...(existing || {}),
      ...job,
      job_id: jobId,
      created_at: createdAt,
      updated_at: updatedAt,
      status,
      expires_at_ms: Date.now() + this.ttlMs,
    };

    this.jobs.delete(jobId);
    this.jobs.set(jobId, next);
    this.onMutate();
    this.enforceCapacity();
    return next;
  }

  get(jobId) {
    if (typeof jobId !== 'string' || !jobId.trim().length) {
      return null;
    }
    const job = this.touch(jobId.trim());
    return job || null;
  }

  has(jobId) {
    if (typeof jobId !== 'string' || !jobId.trim().length) {
      return false;
    }
    return this.jobs.has(jobId.trim());
  }

  list({ limit, status } = {}) {
    const max = Math.min(readPositiveInt(limit) ?? 50, 200);
    const filterStatus = this.normalizeStatus(status);

    const out = [];
    const values = Array.from(this.jobs.values()).reverse();
    for (const job of values) {
      if (filterStatus && job.status !== filterStatus) {
        continue;
      }
      out.push(job);
      if (out.length >= max) {
        break;
      }
    }

    return out;
  }

  forget(jobId) {
    if (typeof jobId !== 'string' || !jobId.trim().length) {
      return false;
    }
    const key = jobId.trim();
    const existed = this.jobs.delete(key);
    if (existed) {
      this.onMutate();
    }
    return existed;
  }

  load(records) {
    if (!Array.isArray(records)) {
      return;
    }
    for (const record of records) {
      if (!record || typeof record !== 'object') {
        continue;
      }
      const jobId = typeof record.job_id === 'string' && record.job_id.trim().length ? record.job_id.trim() : null;
      if (!jobId) {
        continue;
      }
      this.jobs.set(jobId, {
        ...record,
        job_id: jobId,
      });
    }
    this.enforceCapacity();
  }

  toJSON() {
    return {
      version: 1,
      updated_at: nowIso(),
      jobs: Array.from(this.jobs.values()),
    };
  }

  getStats() {
    return {
      jobs: this.jobs.size,
      max_jobs: this.maxJobs,
      ttl_ms: this.ttlMs,
      store: this.source,
    };
  }

  async flush() {
    return;
  }
}

module.exports = MemoryJobStore;
