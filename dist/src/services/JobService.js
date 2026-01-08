#!/usr/bin/env node
"use strict";
// @ts-nocheck
Object.defineProperty(exports, "__esModule", { value: true });
const MemoryJobStore = require('../stores/MemoryJobStore');
const FileJobStore = require('../stores/FileJobStore');
function nowIso() {
    return new Date().toISOString();
}
function resolveStoreKind() {
    const raw = String(process.env.SENTRYFROGG_JOBS_STORE || process.env.SF_JOBS_STORE || 'memory')
        .trim()
        .toLowerCase();
    if (!raw || raw === 'memory' || raw === 'mem' || raw === 'in-memory') {
        return 'memory';
    }
    if (raw === 'file' || raw === 'durable' || raw === 'persistent' || raw === 'sqlite') {
        return 'file';
    }
    return 'memory';
}
class JobService {
    constructor(logger) {
        this.logger = logger?.child ? logger.child('jobs') : logger;
        this.abortControllers = new Map();
        const kind = resolveStoreKind();
        this.store = kind === 'file'
            ? new FileJobStore(this.logger)
            : new MemoryJobStore(this.logger);
    }
    ensureAbortController(jobId) {
        if (this.abortControllers.has(jobId)) {
            return this.abortControllers.get(jobId);
        }
        const controller = new AbortController();
        this.abortControllers.set(jobId, controller);
        return controller;
    }
    purgeExpired(now = Date.now()) {
        const removed = this.store.purgeExpired(now);
        for (const jobId of removed) {
            this.abortControllers.delete(jobId);
        }
    }
    pruneAbortControllers() {
        for (const jobId of this.abortControllers.keys()) {
            if (!this.store.has(jobId)) {
                this.abortControllers.delete(jobId);
            }
        }
    }
    create({ kind, trace_id, parent_span_id, provider, progress } = {}) {
        this.purgeExpired();
        const record = this.store.create({ kind, trace_id, parent_span_id, provider, progress });
        this.ensureAbortController(record.job_id);
        this.pruneAbortControllers();
        return record;
    }
    upsert(job) {
        this.purgeExpired();
        const next = this.store.upsert(job);
        if (!next) {
            return null;
        }
        this.ensureAbortController(next.job_id);
        this.pruneAbortControllers();
        return next;
    }
    get(jobId) {
        if (typeof jobId !== 'string' || !jobId.trim().length) {
            return null;
        }
        this.purgeExpired();
        const job = this.store.get(jobId.trim());
        if (job) {
            this.ensureAbortController(job.job_id);
        }
        return job || null;
    }
    list({ limit, status } = {}) {
        this.purgeExpired();
        return this.store.list({ limit, status });
    }
    forget(jobId) {
        const existed = this.store.forget(jobId);
        if (existed && typeof jobId === 'string') {
            this.abortControllers.delete(jobId.trim());
        }
        this.pruneAbortControllers();
        return existed;
    }
    getAbortSignal(jobId) {
        const controller = this.ensureAbortController(jobId);
        return controller.signal;
    }
    cancel(jobId, reason) {
        const job = this.get(jobId);
        if (!job) {
            return null;
        }
        const controller = this.ensureAbortController(job.job_id);
        if (!controller.signal.aborted) {
            controller.abort(reason || 'canceled');
        }
        const endedAt = nowIso();
        const next = this.store.upsert({
            job_id: job.job_id,
            status: 'canceled',
            ended_at: job.ended_at || endedAt,
        });
        this.pruneAbortControllers();
        return next;
    }
    getStats() {
        this.purgeExpired();
        this.pruneAbortControllers();
        return this.store.getStats();
    }
    async flush() {
        await this.store.flush();
    }
    async cleanup() {
        await this.flush();
        this.abortControllers.clear();
    }
}
module.exports = JobService;
