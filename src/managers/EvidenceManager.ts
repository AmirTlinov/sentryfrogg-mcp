#!/usr/bin/env node
// @ts-nocheck

/**
 * 🧾 Evidence Manager
 */

const { unknownActionError } = require('../utils/toolErrors');

const EVIDENCE_ACTIONS = ['list', 'get'];

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
        throw unknownActionError({ tool: 'evidence', action, knownActions: EVIDENCE_ACTIONS });
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
