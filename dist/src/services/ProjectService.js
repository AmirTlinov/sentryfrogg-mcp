#!/usr/bin/env node
"use strict";
// @ts-nocheck
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * 🗂️ Project registry (JSON file).
 */
const fs = require('fs/promises');
const { resolveProjectsPath } = require('../utils/paths');
const { atomicWriteTextFile } = require('../utils/fsAtomic');
const ToolError = require('../errors/ToolError');
class ProjectService {
    constructor(logger) {
        this.logger = logger.child('projects');
        this.filePath = resolveProjectsPath();
        this.projects = new Map();
        this.stats = {
            loaded: 0,
            saved: 0,
            created: 0,
            updated: 0,
            errors: 0,
        };
        this.initPromise = this.load();
    }
    async initialize() {
        await this.initPromise;
    }
    async ensureReady() {
        await this.initPromise;
    }
    async load() {
        try {
            const raw = await fs.readFile(this.filePath, 'utf8');
            const parsed = JSON.parse(raw);
            for (const [name, project] of Object.entries(parsed || {})) {
                try {
                    this.validateProject(project);
                    this.projects.set(name, project);
                }
                catch (error) {
                    this.stats.errors += 1;
                    this.logger.warn('Skipping invalid project entry during load', { name, error: error.message });
                }
            }
            this.stats.loaded = this.projects.size;
        }
        catch (error) {
            if (error.code !== 'ENOENT') {
                this.stats.errors += 1;
                this.logger.warn('Failed to load projects file', { error: error.message });
            }
        }
    }
    async persist() {
        const data = Object.fromEntries(this.projects);
        await atomicWriteTextFile(this.filePath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
        this.stats.saved += 1;
    }
    validatePolicyObject(policy, labelPrefix) {
        if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
            throw ToolError.invalidParams({ field: labelPrefix, message: `${labelPrefix} must be an object` });
        }
        const allowString = (value, label) => {
            if (value === undefined || value === null) {
                return;
            }
            if (typeof value !== 'string' || value.trim().length === 0) {
                throw ToolError.invalidParams({ field: label, message: `${label} must be a non-empty string` });
            }
        };
        allowString(policy.mode, `${labelPrefix}.mode`);
        const allowOptionalObject = (value, label) => {
            if (value === undefined || value === null) {
                return;
            }
            if (typeof value !== 'object' || Array.isArray(value)) {
                throw ToolError.invalidParams({ field: label, message: `${label} must be an object` });
            }
        };
        allowOptionalObject(policy.allow, `${labelPrefix}.allow`);
        if (policy.allow?.intents !== undefined && policy.allow?.intents !== null) {
            if (!Array.isArray(policy.allow.intents)) {
                throw ToolError.invalidParams({ field: `${labelPrefix}.allow.intents`, message: `${labelPrefix}.allow.intents must be an array` });
            }
        }
        allowOptionalObject(policy.repo, `${labelPrefix}.repo`);
        if (policy.repo?.allowed_remotes !== undefined && policy.repo?.allowed_remotes !== null) {
            if (!Array.isArray(policy.repo.allowed_remotes)) {
                throw ToolError.invalidParams({ field: `${labelPrefix}.repo.allowed_remotes`, message: `${labelPrefix}.repo.allowed_remotes must be an array` });
            }
        }
        allowOptionalObject(policy.kubernetes, `${labelPrefix}.kubernetes`);
        if (policy.kubernetes?.allowed_namespaces !== undefined && policy.kubernetes?.allowed_namespaces !== null) {
            if (!Array.isArray(policy.kubernetes.allowed_namespaces)) {
                throw ToolError.invalidParams({ field: `${labelPrefix}.kubernetes.allowed_namespaces`, message: `${labelPrefix}.kubernetes.allowed_namespaces must be an array` });
            }
        }
        if (policy.change_windows !== undefined && policy.change_windows !== null) {
            if (!Array.isArray(policy.change_windows)) {
                throw ToolError.invalidParams({ field: `${labelPrefix}.change_windows`, message: `${labelPrefix}.change_windows must be an array` });
            }
        }
        allowOptionalObject(policy.lock, `${labelPrefix}.lock`);
        if (policy.lock?.enabled !== undefined && typeof policy.lock.enabled !== 'boolean') {
            throw ToolError.invalidParams({ field: `${labelPrefix}.lock.enabled`, message: `${labelPrefix}.lock.enabled must be a boolean` });
        }
        if (policy.lock?.ttl_ms !== undefined && policy.lock.ttl_ms !== null) {
            const numeric = Number(policy.lock.ttl_ms);
            if (!Number.isFinite(numeric) || numeric <= 0) {
                throw ToolError.invalidParams({ field: `${labelPrefix}.lock.ttl_ms`, message: `${labelPrefix}.lock.ttl_ms must be a positive number` });
            }
        }
    }
    validateTarget(target) {
        if (!target || typeof target !== 'object' || Array.isArray(target)) {
            throw ToolError.invalidParams({ field: 'project.targets', message: 'project.targets entries must be objects' });
        }
        const allowString = (value, label) => {
            if (value === undefined || value === null) {
                return;
            }
            if (typeof value !== 'string' || value.trim().length === 0) {
                throw ToolError.invalidParams({ field: label, message: `${label} must be a non-empty string` });
            }
        };
        const policy = target.policy;
        if (policy !== undefined && policy !== null) {
            if (typeof policy === 'string') {
                allowString(policy, 'target.policy');
            }
            else {
                this.validatePolicyObject(policy, 'target.policy');
            }
        }
        allowString(target.ssh_profile, 'target.ssh_profile');
        allowString(target.env_profile, 'target.env_profile');
        allowString(target.postgres_profile, 'target.postgres_profile');
        allowString(target.api_profile, 'target.api_profile');
        allowString(target.vault_profile, 'target.vault_profile');
        allowString(target.cwd, 'target.cwd');
        allowString(target.env_path, 'target.env_path');
        allowString(target.description, 'target.description');
    }
    validateProject(project) {
        if (!project || typeof project !== 'object' || Array.isArray(project)) {
            throw ToolError.invalidParams({ field: 'project', message: 'project must be an object' });
        }
        if (project.description !== undefined && (typeof project.description !== 'string')) {
            throw ToolError.invalidParams({ field: 'project.description', message: 'project.description must be a string' });
        }
        if (project.default_target !== undefined) {
            if (typeof project.default_target !== 'string' || project.default_target.trim().length === 0) {
                throw ToolError.invalidParams({ field: 'project.default_target', message: 'project.default_target must be a non-empty string' });
            }
        }
        if (project.repo_root !== undefined && project.repo_root !== null) {
            if (typeof project.repo_root !== 'string' || project.repo_root.trim().length === 0) {
                throw ToolError.invalidParams({ field: 'project.repo_root', message: 'project.repo_root must be a non-empty string' });
            }
        }
        if (project.policy_profiles !== undefined && project.policy_profiles !== null) {
            if (typeof project.policy_profiles !== 'object' || Array.isArray(project.policy_profiles)) {
                throw ToolError.invalidParams({ field: 'project.policy_profiles', message: 'project.policy_profiles must be an object' });
            }
            for (const [name, policy] of Object.entries(project.policy_profiles)) {
                if (typeof name !== 'string' || name.trim().length === 0) {
                    throw ToolError.invalidParams({ field: 'project.policy_profiles', message: 'project.policy_profiles keys must be non-empty strings' });
                }
                this.validatePolicyObject(policy, `project.policy_profiles.${name}`);
            }
        }
        if (project.targets !== undefined) {
            if (!project.targets || typeof project.targets !== 'object' || Array.isArray(project.targets)) {
                throw ToolError.invalidParams({ field: 'project.targets', message: 'project.targets must be an object' });
            }
            for (const [name, target] of Object.entries(project.targets)) {
                if (typeof name !== 'string' || name.trim().length === 0) {
                    throw ToolError.invalidParams({ field: 'project.targets', message: 'project.targets keys must be non-empty strings' });
                }
                this.validateTarget(target);
            }
        }
    }
    normalizeName(name) {
        if (typeof name !== 'string' || name.trim().length === 0) {
            throw ToolError.invalidParams({ field: 'name', message: 'project name must be a non-empty string' });
        }
        return name.trim();
    }
    async setProject(name, project) {
        await this.ensureReady();
        const trimmed = this.normalizeName(name);
        this.validateProject(project);
        const existing = this.projects.get(trimmed);
        const payload = {
            ...project,
            updated_at: new Date().toISOString(),
            created_at: existing?.created_at || new Date().toISOString(),
        };
        this.projects.set(trimmed, payload);
        await this.persist();
        if (existing) {
            this.stats.updated += 1;
        }
        else {
            this.stats.created += 1;
        }
        return { success: true, project: { name: trimmed, ...payload } };
    }
    async getProject(name) {
        await this.ensureReady();
        const trimmed = this.normalizeName(name);
        const entry = this.projects.get(trimmed);
        if (!entry) {
            throw ToolError.notFound({
                code: 'PROJECT_NOT_FOUND',
                message: `project '${trimmed}' not found`,
                hint: 'Use action=project_list to see known projects.',
                details: { name: trimmed },
            });
        }
        return { success: true, project: { name: trimmed, ...entry } };
    }
    async listProjects() {
        await this.ensureReady();
        const items = [];
        for (const [name, project] of this.projects.entries()) {
            items.push({
                name,
                description: project.description,
                default_target: project.default_target,
                targets: project.targets ? Object.keys(project.targets).length : 0,
                created_at: project.created_at,
                updated_at: project.updated_at,
            });
        }
        return { success: true, projects: items };
    }
    async deleteProject(name) {
        await this.ensureReady();
        const trimmed = this.normalizeName(name);
        if (!this.projects.delete(trimmed)) {
            throw ToolError.notFound({
                code: 'PROJECT_NOT_FOUND',
                message: `project '${trimmed}' not found`,
                hint: 'Use action=project_list to see known projects.',
                details: { name: trimmed },
            });
        }
        await this.persist();
        return { success: true, project: trimmed };
    }
    async resolveProject(name) {
        await this.ensureReady();
        if (!name || typeof name !== 'string') {
            return null;
        }
        return this.projects.get(name.trim()) || null;
    }
    getStats() {
        return { ...this.stats, total: this.projects.size };
    }
    async cleanup() {
        this.projects.clear();
    }
}
module.exports = ProjectService;
