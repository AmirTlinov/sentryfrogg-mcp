#!/usr/bin/env node
"use strict";
// @ts-nocheck
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * 🧾 Evidence Manager
 */
class EvidenceManager {
    constructor(logger, security, validation, evidenceService) {
        this.logger = logger.child('evidence');
        this.security = security;
        this.validation = validation;
        this.evidenceService = evidenceService;
    }
    async handleAction(args = {}) {
        const { action } = args;
        switch (action) {
            case 'list':
                return this.list(args);
            case 'get':
                return this.get(args);
            default:
                throw new Error(`Unknown evidence action: ${action}`);
        }
    }
    async list(args) {
        const limit = args.limit ? Number(args.limit) : 20;
        const entries = await this.evidenceService.listEvidence(limit);
        return { success: true, evidence: entries };
    }
    async get(args) {
        const id = this.validation.ensureString(args.id, 'Evidence id');
        const payload = await this.evidenceService.getEvidence(id);
        return { success: true, ...payload };
    }
}
module.exports = EvidenceManager;
