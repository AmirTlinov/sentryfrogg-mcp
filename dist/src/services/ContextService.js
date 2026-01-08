#!/usr/bin/env node
"use strict";
// @ts-nocheck
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * 🧭 Project context cache (safe metadata only).
 */
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { resolveContextPath } = require('../utils/paths');
const { atomicWriteTextFile, pathExists } = require('../utils/fsAtomic');
const MARKERS = [
    { tag: 'node', files: ['package.json', 'pnpm-lock.yaml', 'yarn.lock'] },
    { tag: 'python', files: ['pyproject.toml', 'requirements.txt', 'Pipfile', 'setup.py'] },
    { tag: 'go', files: ['go.mod'] },
    { tag: 'rust', files: ['Cargo.toml'] },
    { tag: 'java', files: ['pom.xml', 'build.gradle', 'build.gradle.kts'] },
    { tag: 'dotnet', files: ['global.json'] },
    { tag: 'docker', files: ['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml'] },
    { tag: 'k8s', files: ['kustomization.yaml', 'kustomization.yml', 'Kustomization'] },
    { tag: 'helm', files: ['Chart.yaml'] },
    { tag: 'argocd', files: ['.argocd', 'argocd-application.yaml', 'Application.yaml'] },
    {
        tag: 'flux',
        files: [
            '.flux',
            'flux-system',
            'gotk-components.yaml',
            'gotk-sync.yaml',
            'flux-system/gotk-components.yaml',
            'flux-system/gotk-sync.yaml',
            'flux-system/kustomization.yaml',
        ],
    },
    { tag: 'terraform', files: ['main.tf', 'terraform.tf', 'terragrunt.hcl'] },
    { tag: 'ansible', files: ['ansible.cfg', 'playbook.yml', 'playbook.yaml'] },
    { tag: 'ci', files: ['.github/workflows', 'gitlab-ci.yml', 'Jenkinsfile'] },
];
function normalizePath(value) {
    if (!value || typeof value !== 'string') {
        return undefined;
    }
    const trimmed = value.trim();
    if (!trimmed) {
        return undefined;
    }
    return path.resolve(trimmed);
}
async function findGitRoot(startDir) {
    if (!startDir) {
        return undefined;
    }
    let current = startDir;
    for (let depth = 0; depth < 25; depth += 1) {
        const candidate = path.join(current, '.git');
        try {
            if (await pathExists(candidate)) {
                return current;
            }
        }
        catch (error) {
            return undefined;
        }
        const parent = path.dirname(current);
        if (parent === current) {
            break;
        }
        current = parent;
    }
    return undefined;
}
async function detectMarkers(rootDir) {
    const files = {};
    const signals = {};
    if (!rootDir) {
        return { files, signals };
    }
    for (const marker of MARKERS) {
        let hit = false;
        for (const rel of marker.files) {
            const full = path.isAbsolute(rel) ? rel : path.join(rootDir, rel);
            const exists = await pathExists(full).catch(() => false);
            files[rel] = exists;
            if (exists) {
                hit = true;
            }
        }
        signals[marker.tag] = hit;
    }
    return { files, signals };
}
function deriveTags(signals, gitRoot) {
    const tags = Object.entries(signals)
        .filter(([, value]) => value)
        .map(([key]) => key);
    if (signals.argocd || signals.flux) {
        tags.push('gitops');
    }
    if (gitRoot) {
        tags.push('git');
    }
    return tags.sort();
}
class ContextService {
    constructor(logger, projectResolver) {
        this.logger = logger.child('context');
        this.projectResolver = projectResolver;
        this.filePath = resolveContextPath();
        this.contexts = new Map();
        this.stats = {
            loaded: 0,
            saved: 0,
            refreshed: 0,
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
            const entries = parsed.contexts || parsed;
            if (entries && typeof entries === 'object' && !Array.isArray(entries)) {
                for (const [key, value] of Object.entries(entries)) {
                    if (value && typeof value === 'object') {
                        this.contexts.set(key, value);
                    }
                }
            }
            this.stats.loaded = this.contexts.size;
        }
        catch (error) {
            if (error.code !== 'ENOENT') {
                this.logger.warn('Failed to load context file', { error: error.message });
            }
        }
    }
    async persist() {
        const data = {
            version: 1,
            contexts: Object.fromEntries(this.contexts),
        };
        await atomicWriteTextFile(this.filePath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
        this.stats.saved += 1;
    }
    async ensureReady() {
        await this.initPromise;
    }
    async resolveInputs(args = {}) {
        let projectName = args.project ? String(args.project) : undefined;
        let targetName = args.target ? String(args.target) : undefined;
        let cwd = normalizePath(args.cwd);
        let repoRoot = normalizePath(args.repo_root);
        if (this.projectResolver) {
            const context = await this.projectResolver.resolveContext(args).catch(() => null);
            if (context?.projectName && !projectName) {
                projectName = context.projectName;
            }
            if (context?.targetName && !targetName) {
                targetName = context.targetName;
            }
            if (!cwd && context?.target?.cwd) {
                cwd = normalizePath(context.target.cwd);
            }
            if (!repoRoot && context?.project?.repo_root) {
                repoRoot = normalizePath(context.project.repo_root);
            }
        }
        if (!cwd && repoRoot) {
            cwd = repoRoot;
        }
        if (!cwd) {
            cwd = process.cwd();
        }
        return { projectName, targetName, cwd, repoRoot };
    }
    buildKey({ key, projectName, targetName, cwd }) {
        if (key && typeof key === 'string' && key.trim().length > 0) {
            return key.trim();
        }
        if (projectName) {
            return `project:${projectName}:${targetName || 'default'}`;
        }
        return `cwd:${cwd}`;
    }
    async getContext(args = {}) {
        await this.ensureReady();
        const { projectName, targetName, cwd, repoRoot } = await this.resolveInputs(args);
        const key = this.buildKey({ key: args.key, projectName, targetName, cwd });
        const refresh = args.refresh === true;
        const existing = this.contexts.get(key);
        if (existing && !refresh) {
            return { success: true, context: existing };
        }
        const updated = await this.refreshContext({ projectName, targetName, cwd, repoRoot, key });
        return { success: true, context: updated };
    }
    async refreshContext({ projectName, targetName, cwd, repoRoot, key }) {
        await this.ensureReady();
        const normalizedCwd = normalizePath(cwd) || process.cwd();
        const gitRoot = await findGitRoot(normalizedCwd);
        const root = repoRoot || gitRoot || normalizedCwd;
        const { files, signals } = await detectMarkers(root);
        const tags = deriveTags(signals, gitRoot);
        const payload = {
            key,
            root,
            cwd: normalizedCwd,
            project_name: projectName,
            target_name: targetName,
            repo_root: repoRoot,
            git: gitRoot ? { root: gitRoot } : undefined,
            tags,
            signals,
            files,
            updated_at: new Date().toISOString(),
            host: os.hostname(),
        };
        this.contexts.set(key, payload);
        await this.persist();
        this.stats.refreshed += 1;
        return payload;
    }
    async listContexts() {
        await this.ensureReady();
        const items = [];
        for (const [key, value] of this.contexts.entries()) {
            items.push({
                key,
                updated_at: value.updated_at,
                root: value.root,
                tags: value.tags,
                project_name: value.project_name,
                target_name: value.target_name,
            });
        }
        return { success: true, contexts: items };
    }
    getStats() {
        return { ...this.stats, total: this.contexts.size };
    }
    async cleanup() {
        this.contexts.clear();
    }
}
module.exports = ContextService;
