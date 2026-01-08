#!/usr/bin/env node
// @ts-nocheck

/**
 * 🧭 Context Manager
 */

class ContextManager {
  constructor(logger, validation, contextService) {
    this.logger = logger.child('context');
    this.validation = validation;
    this.contextService = contextService;
  }

  async handleAction(args = {}) {
    const { action } = args;
    switch (action) {
      case 'get':
        return this.get(args);
      case 'refresh':
        return this.refresh(args);
      case 'summary':
        return this.summary(args);
      case 'list':
        return this.list();
      case 'stats':
        return this.contextService.getStats();
      default:
        throw new Error(`Unknown context action: ${action}`);
    }
  }

  normalizeArgs(args) {
    const payload = { ...args };
    if (payload.project) {
      payload.project = this.validation.ensureString(payload.project, 'project');
    }
    if (payload.target) {
      payload.target = this.validation.ensureString(payload.target, 'target');
    }
    if (payload.cwd) {
      payload.cwd = this.validation.ensureString(payload.cwd, 'cwd', { trim: false });
    }
    if (payload.repo_root) {
      payload.repo_root = this.validation.ensureString(payload.repo_root, 'repo_root', { trim: false });
    }
    if (payload.key) {
      payload.key = this.validation.ensureString(payload.key, 'key', { trim: false });
    }
    return payload;
  }

  async get(args) {
    const payload = this.normalizeArgs(args);
    return this.contextService.getContext(payload);
  }

  async refresh(args) {
    const payload = this.normalizeArgs(args);
    return this.contextService.getContext({ ...payload, refresh: true });
  }

  async summary(args) {
    const payload = this.normalizeArgs(args);
    const result = await this.contextService.getContext(payload);
    const context = result.context || {};
    return {
      success: true,
      summary: {
        key: context.key,
        root: context.root,
        tags: context.tags,
        signals: context.signals,
        project_name: context.project_name,
        target_name: context.target_name,
        updated_at: context.updated_at,
      },
    };
  }

  async list() {
    return this.contextService.listContexts();
  }
}

module.exports = ContextManager;
