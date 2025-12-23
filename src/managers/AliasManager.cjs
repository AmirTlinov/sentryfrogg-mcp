#!/usr/bin/env node

/**
 * 🧩 Alias manager.
 */

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
        throw new Error(`Unknown alias action: ${action}`);
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
