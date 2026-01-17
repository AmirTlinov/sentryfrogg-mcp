#!/usr/bin/env node
"use strict";
// @ts-nocheck
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * 🧭 Workspace Manager
 */
const { unknownActionError } = require('../utils/toolErrors');
const ToolError = require('../errors/ToolError');
const WORKSPACE_ACTIONS = ['summary', 'suggest', 'diagnose', 'store_status', 'run', 'cleanup', 'stats'];
class WorkspaceManager {
    constructor(logger, validation, workspaceService, runbookManager, intentManager, sshManager) {
        this.logger = logger.child('workspace');
        this.validation = validation;
        this.workspaceService = workspaceService;
        this.runbookManager = runbookManager;
        this.intentManager = intentManager;
        this.sshManager = sshManager;
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
            case 'run':
                return this.run(args);
            case 'cleanup':
                return this.cleanup(args);
            case 'stats':
                return this.workspaceService.getStats();
            default:
                throw unknownActionError({ tool: 'workspace', action, knownActions: WORKSPACE_ACTIONS });
        }
    }
    async cleanup() {
        const results = {};
        if (this.runbookManager?.cleanup) {
            await this.runbookManager.cleanup();
            results.runbook = { success: true };
        }
        if (this.sshManager?.cleanup) {
            await this.sshManager.cleanup();
            results.ssh = { success: true };
        }
        return { success: true, cleaned: Object.keys(results), results };
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
                throw ToolError.internal({
                    code: 'INTENT_MANAGER_UNAVAILABLE',
                    message: 'Intent manager is not available',
                    hint: 'This is a server configuration error. Enable IntentManager in bootstrap.',
                });
            }
            const type = args.intent?.type || args.intent_type || args.type;
            if (!type) {
                throw ToolError.invalidParams({
                    field: 'intent.type',
                    message: 'intent type is required',
                    hint: 'Provide args.intent={ type, inputs } or args.intent_type.',
                });
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
