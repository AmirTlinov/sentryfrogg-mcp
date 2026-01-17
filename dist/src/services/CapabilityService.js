#!/usr/bin/env node
"use strict";
// @ts-nocheck
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * 🧩 Реестр capability (intent → runbook)
 */
const fs = require('fs/promises');
const { resolveCapabilitiesPath, resolveDefaultCapabilitiesPath } = require('../utils/paths');
const { atomicWriteTextFile } = require('../utils/fsAtomic');
const ToolError = require('../errors/ToolError');
class CapabilityService {
    constructor(logger, security) {
        this.logger = logger.child('capabilities');
        this.security = security;
        this.filePath = resolveCapabilitiesPath();
        this.defaultPath = resolveDefaultCapabilitiesPath();
        this.capabilities = new Map();
        this.sources = new Map();
        this.stats = {
            loaded: 0,
            loaded_default: 0,
            loaded_local: 0,
            created: 0,
            updated: 0,
            saved: 0,
            errors: 0,
        };
        this.initPromise = this.loadCapabilities();
    }
    async initialize() {
        await this.initPromise;
    }
    async ensureReady() {
        await this.initPromise;
    }
    async loadCapabilities() {
        await this.loadFromPath(this.defaultPath, 'default');
        await this.loadFromPath(this.filePath, 'local');
        this.stats.loaded = this.capabilities.size;
    }
    async loadFromPath(filePath, source) {
        if (!filePath) {
            return;
        }
        try {
            const raw = await fs.readFile(filePath, 'utf8');
            const parsed = JSON.parse(raw);
            const rawCapabilities = parsed.capabilities ?? parsed;
            let count = 0;
            if (Array.isArray(rawCapabilities)) {
                for (const entry of rawCapabilities) {
                    if (entry && entry.name) {
                        this.capabilities.set(entry.name, entry);
                        this.sources.set(entry.name, source);
                        count += 1;
                    }
                }
            }
            else {
                for (const [name, entry] of Object.entries(rawCapabilities || {})) {
                    this.capabilities.set(name, { ...entry, name });
                    this.sources.set(name, source);
                    count += 1;
                }
            }
            if (count > 0) {
                this.stats[`loaded_${source}`] += count;
                this.logger.info('Capabilities loaded', { count, source });
            }
        }
        catch (error) {
            if (error.code === 'ENOENT') {
                return;
            }
            this.stats.errors += 1;
            this.logger.error('Failed to load capabilities', { error: error.message, source });
            throw error;
        }
    }
    async persist() {
        const data = {
            version: 1,
            capabilities: Object.fromEntries(this.capabilities),
        };
        this.security.ensureSizeFits(JSON.stringify(data));
        await atomicWriteTextFile(this.filePath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
        this.stats.saved += 1;
    }
    async listCapabilities() {
        await this.ensureReady();
        return Array.from(this.capabilities.values()).map((capability) => ({
            name: capability.name,
            intent: capability.intent,
            description: capability.description,
            runbook: capability.runbook,
            effects: capability.effects,
            inputs: capability.inputs,
            depends_on: capability.depends_on || [],
            tags: capability.tags || [],
            when: capability.when,
            source: this.sources.get(capability.name) || 'local',
        }));
    }
    async getCapability(name) {
        await this.ensureReady();
        if (typeof name !== 'string' || name.trim().length === 0) {
            throw ToolError.invalidParams({ field: 'name', message: 'Capability name must be a non-empty string' });
        }
        const key = name.trim();
        const entry = this.capabilities.get(key);
        if (!entry) {
            throw ToolError.notFound({
                code: 'CAPABILITY_NOT_FOUND',
                message: `Capability '${name}' not found`,
                hint: 'Use action=capability_list to see known capabilities.',
                details: { name: key },
            });
        }
        return entry;
    }
    async findByIntent(intentType) {
        const matches = await this.findAllByIntent(intentType);
        return matches.length > 0 ? matches[0] : null;
    }
    async findAllByIntent(intentType) {
        await this.ensureReady();
        if (typeof intentType !== 'string' || intentType.trim().length === 0) {
            throw ToolError.invalidParams({ field: 'intent.type', message: 'Intent type must be a non-empty string' });
        }
        const key = intentType.trim();
        const matches = [];
        const direct = this.capabilities.get(key);
        if (direct) {
            matches.push(direct);
        }
        for (const capability of this.capabilities.values()) {
            if (capability.intent === key && capability.name !== key) {
                matches.push(capability);
            }
        }
        return matches;
    }
    async setCapability(name, config) {
        await this.ensureReady();
        if (typeof name !== 'string' || name.trim().length === 0) {
            throw ToolError.invalidParams({ field: 'name', message: 'Capability name must be a non-empty string' });
        }
        if (typeof config !== 'object' || config === null || Array.isArray(config)) {
            throw ToolError.invalidParams({ field: 'config', message: 'Capability config must be an object' });
        }
        const trimmedName = name.trim();
        const existing = this.capabilities.get(trimmedName) || {};
        const now = new Date().toISOString();
        const next = {
            ...existing,
            ...config,
            name: trimmedName,
            created_at: existing.created_at || now,
            updated_at: now,
        };
        this.capabilities.set(trimmedName, next);
        this.sources.set(trimmedName, 'local');
        await this.persist();
        if (existing.created_at) {
            this.stats.updated += 1;
        }
        else {
            this.stats.created += 1;
        }
        this.logger.info('Capability saved', { name: trimmedName });
        return next;
    }
    async deleteCapability(name) {
        await this.ensureReady();
        if (!this.capabilities.delete(name)) {
            throw ToolError.notFound({
                code: 'CAPABILITY_NOT_FOUND',
                message: `Capability '${name}' not found`,
                hint: 'Use action=capability_list to see known capabilities.',
                details: { name: String(name || '').trim() },
            });
        }
        await this.persist();
        return { success: true };
    }
    getStats() {
        return { ...this.stats, total: this.capabilities.size };
    }
    async cleanup() {
        this.capabilities.clear();
    }
}
module.exports = CapabilityService;
