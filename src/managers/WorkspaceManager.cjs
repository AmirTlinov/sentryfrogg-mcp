#!/usr/bin/env node

/**
 * 🧭 Workspace Manager
 */

class WorkspaceManager {
  constructor(logger, validation, workspaceService, runbookManager, intentManager) {
    this.logger = logger.child('workspace');
    this.validation = validation;
    this.workspaceService = workspaceService;
    this.runbookManager = runbookManager;
    this.intentManager = intentManager;
  }

  async handleAction(args = {}) {
    const { action } = args;
    switch (action) {
      case 'summary':
        return this.workspaceService.summarize(this.normalizeArgs(args));
      case 'suggest':
        return this.workspaceService.suggest(this.normalizeArgs(args));
      case 'diagnose':
        return this.workspaceService.diagnose(this.normalizeArgs(args));
      case 'store_status':
        return this.workspaceService.getStoreStatus();
      case 'migrate_legacy':
        return this.workspaceService.migrateLegacy(args);
      case 'run':
        return this.run(args);
      case 'stats':
        return this.workspaceService.getStats();
      default:
        throw new Error(`Unknown workspace action: ${action}`);
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
    if (payload.limit !== undefined) {
      payload.limit = Number(payload.limit);
    }
    return payload;
  }

  async run(args) {
    if (args.intent || args.intent_type || args.type) {
      if (!this.intentManager) {
        throw new Error('Intent manager is not available');
      }
      const type = args.intent?.type || args.intent_type || args.type;
      if (!type) {
        throw new Error('intent type is required');
      }
      const inputs = args.intent?.inputs || args.inputs || args.input || {};
      const intent = { type, inputs };

      const apply = Boolean(args.apply);
      if (apply) {
        return this.intentManager.handleAction({ ...args, action: 'execute', intent });
      }

      const compiled = await this.intentManager.handleAction({ ...args, action: 'compile', intent });
      const requiresApply = Boolean(compiled?.plan?.effects?.requires_apply);

      const action = requiresApply ? 'dry_run' : 'execute';
      return this.intentManager.handleAction({ ...args, action, intent });
    }
    return this.runbookManager.handleAction({ ...args, action: 'runbook_run' });
  }
}

module.exports = WorkspaceManager;
