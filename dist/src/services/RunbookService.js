#!/usr/bin/env node
"use strict";
// @ts-nocheck
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * 📚 Runbook storage (JSON file).
 */
const fs = require('fs/promises');
const { resolveRunbooksPath, resolveDefaultRunbooksPath } = require('../utils/paths');
const { atomicWriteTextFile } = require('../utils/fsAtomic');
class RunbookService {
    constructor(logger) {
        this.logger = logger.child('runbooks');
        this.filePath = resolveRunbooksPath();
        this.defaultPath = resolveDefaultRunbooksPath();
        this.runbooks = new Map();
        this.sources = new Map();
        this.stats = {
            loaded: 0,
            loaded_default: 0,
            loaded_local: 0,
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
        await this.loadFromPath(this.defaultPath, 'default');
        await this.loadFromPath(this.filePath, 'local');
        this.stats.loaded = this.runbooks.size;
    }
    async loadFromPath(filePath, source) {
        if (!filePath) {
            return;
        }
        try {
            const raw = await fs.readFile(filePath, 'utf8');
            const parsed = JSON.parse(raw);
            let count = 0;
            for (const [name, runbook] of Object.entries(parsed || {})) {
                this.runbooks.set(name, runbook);
                this.sources.set(name, source);
                count += 1;
            }
            if (count > 0) {
                this.stats[`loaded_${source}`] += count;
            }
        }
        catch (error) {
            if (error.code !== 'ENOENT') {
                this.logger.warn('Failed to load runbooks file', { error: error.message, source });
            }
        }
    }
    async persist() {
        const data = Object.fromEntries(this.runbooks);
        await atomicWriteTextFile(this.filePath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
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
        this.sources.set(trimmed, 'local');
        await this.persist();
        if (existing) {
            this.stats.updated += 1;
        }
        else {
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
        return { success: true, runbook: { name: trimmed, ...entry, source: this.sources.get(trimmed) || 'local' } };
    }
    async listRunbooks() {
        await this.ensureReady();
        const items = [];
        for (const [name, runbook] of this.runbooks.entries()) {
            items.push({
                name,
                description: runbook.description,
                tags: runbook.tags || [],
                when: runbook.when,
                inputs: runbook.inputs,
                steps: Array.isArray(runbook.steps) ? runbook.steps.length : 0,
                created_at: runbook.created_at,
                updated_at: runbook.updated_at,
                source: this.sources.get(name) || 'local',
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
