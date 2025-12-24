#!/usr/bin/env node

/**
 * 🗂️ Project registry (JSON file).
 */

const fs = require('fs/promises');
const { resolveProjectsPath } = require('../utils/paths.cjs');
const { atomicWriteTextFile } = require('../utils/fsAtomic.cjs');

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
        this.validateProject(project);
        this.projects.set(name, project);
      }
      this.stats.loaded = this.projects.size;
    } catch (error) {
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

  validateTarget(target) {
    if (!target || typeof target !== 'object' || Array.isArray(target)) {
      throw new Error('project.targets entries must be objects');
    }

    const allowString = (value, label) => {
      if (value === undefined || value === null) {
        return;
      }
      if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`${label} must be a non-empty string`);
      }
    };

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
      throw new Error('project must be an object');
    }

    if (project.description !== undefined && (typeof project.description !== 'string')) {
      throw new Error('project.description must be a string');
    }

    if (project.default_target !== undefined) {
      if (typeof project.default_target !== 'string' || project.default_target.trim().length === 0) {
        throw new Error('project.default_target must be a non-empty string');
      }
    }

    if (project.targets !== undefined) {
      if (!project.targets || typeof project.targets !== 'object' || Array.isArray(project.targets)) {
        throw new Error('project.targets must be an object');
      }
      for (const [name, target] of Object.entries(project.targets)) {
        if (typeof name !== 'string' || name.trim().length === 0) {
          throw new Error('project.targets keys must be non-empty strings');
        }
        this.validateTarget(target);
      }
    }
  }

  normalizeName(name) {
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new Error('project name must be a non-empty string');
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
    } else {
      this.stats.created += 1;
    }

    return { success: true, project: { name: trimmed, ...payload } };
  }

  async getProject(name) {
    await this.ensureReady();
    const trimmed = this.normalizeName(name);
    const entry = this.projects.get(trimmed);
    if (!entry) {
      throw new Error(`project '${trimmed}' not found`);
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
      throw new Error(`project '${trimmed}' not found`);
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
