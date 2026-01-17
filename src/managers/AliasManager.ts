#!/usr/bin/env node
// @ts-nocheck

/**
 * 🧩 Alias manager.
 */

const { unknownActionError } = require('../utils/toolErrors');

const ALIAS_ACTIONS = ['alias_upsert', 'alias_get', 'alias_list', 'alias_delete', 'alias_resolve'];

class AliasManager {
  constructor(logger, aliasService) {
    this.logger = logger.child('alias');
    this.aliasService = aliasService;
  }

  async handleAction(args = {}) {
    const { action } = args;

    switch (action) {
      case 'alias_upsert':
        return this.aliasService.setAlias(args.name, args.alias || args);
      case 'alias_get':
        return this.aliasService.getAlias(args.name);
      case 'alias_list':
        return this.aliasService.listAliases();
      case 'alias_delete':
        return this.aliasService.deleteAlias(args.name);
      case 'alias_resolve': {
        const resolved = await this.aliasService.resolveAlias(args.name);
        return { success: true, alias: resolved ? { name: args.name, ...resolved } : null };
      }
      default:
        throw unknownActionError({ tool: 'alias', action, knownActions: ALIAS_ACTIONS });
    }
  }

  getStats() {
    return this.aliasService.getStats();
  }

  async cleanup() {
    await this.aliasService.cleanup();
  }
}

module.exports = AliasManager;
