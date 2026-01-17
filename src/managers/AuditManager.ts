#!/usr/bin/env node
// @ts-nocheck

/**
 * 🧾 Audit log manager.
 */

const { unknownActionError } = require('../utils/toolErrors');

const AUDIT_ACTIONS = ['audit_list', 'audit_tail', 'audit_clear', 'audit_stats'];

class AuditManager {
  constructor(logger, auditService) {
    this.logger = logger.child('audit');
    this.auditService = auditService;
  }

  async handleAction(args = {}) {
    const { action } = args;

    switch (action) {
      case 'audit_list':
        return this.auditService.readEntries({
          limit: args.limit,
          offset: args.offset,
          reverse: args.reverse === true,
          filters: {
            trace_id: args.trace_id,
            tool: args.tool,
            action: args.audit_action,
            status: args.status,
            since: args.since,
          },
        });
      case 'audit_tail':
        return this.auditService.readEntries({
          limit: args.limit || 50,
          offset: 0,
          reverse: true,
          filters: {
            trace_id: args.trace_id,
            tool: args.tool,
            action: args.audit_action,
            status: args.status,
            since: args.since,
          },
        });
      case 'audit_clear':
        return this.auditService.clear();
      case 'audit_stats':
        return { success: true, stats: this.auditService.getStats() };
      default:
        throw unknownActionError({ tool: 'audit', action, knownActions: AUDIT_ACTIONS });
    }
  }

  getStats() {
    return this.auditService.getStats();
  }

  async cleanup() {
    await this.auditService.cleanup();
  }
}

module.exports = AuditManager;
