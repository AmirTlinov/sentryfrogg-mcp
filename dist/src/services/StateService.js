#!/usr/bin/env node
"use strict";
// @ts-nocheck
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * 🧠 In-process state store with optional persistence.
 */
const fs = require('fs/promises');
const { resolveStatePath } = require('../utils/paths');
const { atomicWriteTextFile } = require('../utils/fsAtomic');
class StateService {
    constructor(logger) {
        this.logger = logger.child('state');
        this.filePath = resolveStatePath();
        this.persistent = {};
        this.session = {};
        this.stats = {
            loaded: 0,
            saved: 0,
            set: 0,
            unset: 0,
            cleared: 0,
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
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                this.persistent = parsed;
            }
            this.stats.loaded = Object.keys(this.persistent).length;
        }
        catch (error) {
            if (error.code !== 'ENOENT') {
                this.logger.warn('Failed to load state file', { error: error.message });
            }
        }
    }
    async persist() {
        await atomicWriteTextFile(this.filePath, `${JSON.stringify(this.persistent, null, 2)}\n`, { mode: 0o600 });
        this.stats.saved += 1;
    }
    async ensureReady() {
        await this.initPromise;
    }
    normalizeScope(scope) {
        const normalized = String(scope || 'persistent').toLowerCase();
        if (normalized === 'session' || normalized === 'persistent' || normalized === 'any') {
            return normalized;
        }
        throw new Error('scope must be one of: session, persistent, any');
    }
    async set(key, value, scope) {
        await this.ensureReady();
        if (typeof key !== 'string' || key.trim().length === 0) {
            throw new Error('State key must be a non-empty string');
        }
        const normalized = this.normalizeScope(scope);
        if (normalized === 'session') {
            this.session[key.trim()] = value;
        }
        else {
            this.persistent[key.trim()] = value;
            await this.persist();
        }
        this.stats.set += 1;
        return { success: true, key: key.trim(), scope: normalized === 'any' ? 'persistent' : normalized };
    }
    async get(key, scope) {
        await this.ensureReady();
        if (typeof key !== 'string' || key.trim().length === 0) {
            throw new Error('State key must be a non-empty string');
        }
        const normalized = this.normalizeScope(scope || 'any');
        const trimmed = key.trim();
        let value;
        let resolvedScope;
        if (normalized === 'session') {
            value = this.session[trimmed];
            resolvedScope = 'session';
        }
        else if (normalized === 'persistent') {
            value = this.persistent[trimmed];
            resolvedScope = 'persistent';
        }
        else {
            if (Object.prototype.hasOwnProperty.call(this.session, trimmed)) {
                value = this.session[trimmed];
                resolvedScope = 'session';
            }
            else {
                value = this.persistent[trimmed];
                resolvedScope = 'persistent';
            }
        }
        return { success: true, key: trimmed, value, scope: resolvedScope };
    }
    async list({ prefix, scope, includeValues } = {}) {
        await this.ensureReady();
        const normalized = this.normalizeScope(scope || 'any');
        const matchesPrefix = (key) => (prefix ? key.startsWith(prefix) : true);
        const gather = (source) => Object.entries(source)
            .filter(([key]) => matchesPrefix(key))
            .map(([key, value]) => (includeValues ? { key, value } : { key }));
        if (normalized === 'session') {
            return { success: true, scope: 'session', items: gather(this.session) };
        }
        if (normalized === 'persistent') {
            return { success: true, scope: 'persistent', items: gather(this.persistent) };
        }
        return {
            success: true,
            scope: 'any',
            items: [
                ...gather(this.persistent),
                ...gather(this.session).filter((item) => !Object.prototype.hasOwnProperty.call(this.persistent, item.key)),
            ],
        };
    }
    async unset(key, scope) {
        await this.ensureReady();
        if (typeof key !== 'string' || key.trim().length === 0) {
            throw new Error('State key must be a non-empty string');
        }
        const normalized = this.normalizeScope(scope || 'any');
        const trimmed = key.trim();
        if (normalized === 'session' || normalized === 'any') {
            delete this.session[trimmed];
        }
        if (normalized === 'persistent' || normalized === 'any') {
            delete this.persistent[trimmed];
            await this.persist();
        }
        this.stats.unset += 1;
        return { success: true, key: trimmed, scope: normalized };
    }
    async clear(scope) {
        await this.ensureReady();
        const normalized = this.normalizeScope(scope || 'any');
        if (normalized === 'session' || normalized === 'any') {
            this.session = {};
        }
        if (normalized === 'persistent' || normalized === 'any') {
            this.persistent = {};
            await this.persist();
        }
        this.stats.cleared += 1;
        return { success: true, scope: normalized };
    }
    async dump(scope) {
        await this.ensureReady();
        const normalized = this.normalizeScope(scope || 'any');
        if (normalized === 'session') {
            return { success: true, scope: 'session', state: { ...this.session } };
        }
        if (normalized === 'persistent') {
            return { success: true, scope: 'persistent', state: { ...this.persistent } };
        }
        return {
            success: true,
            scope: 'any',
            state: { ...this.persistent, ...this.session },
            persistent: { ...this.persistent },
            session: { ...this.session },
        };
    }
    getStats() {
        return {
            ...this.stats,
            session_keys: Object.keys(this.session).length,
            persistent_keys: Object.keys(this.persistent).length,
        };
    }
    async cleanup() {
        this.session = {};
    }
}
module.exports = StateService;
