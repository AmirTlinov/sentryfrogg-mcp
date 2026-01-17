#!/usr/bin/env node
// @ts-nocheck

/**
 * 🧠 State manager.
 */

const { unknownActionError } = require('../utils/toolErrors');

const STATE_ACTIONS = ['set', 'get', 'list', 'unset', 'clear', 'dump'];

class StateManager {
  constructor(logger, stateService) {
    this.logger = logger.child('state');
    this.stateService = stateService;
  }

  async handleAction(args = {}) {
    const { action } = args;

    switch (action) {
      case 'set':
        return this.stateService.set(args.key, args.value, args.scope);
      case 'get':
        return this.stateService.get(args.key, args.scope);
      case 'list':
        return this.stateService.list({
          prefix: args.prefix,
          scope: args.scope,
          includeValues: args.include_values,
        });
      case 'unset':
        return this.stateService.unset(args.key, args.scope);
      case 'clear':
        return this.stateService.clear(args.scope);
      case 'dump':
        return this.stateService.dump(args.scope);
      default:
        throw unknownActionError({ tool: 'state', action, knownActions: STATE_ACTIONS });
    }
  }

  getStats() {
    return this.stateService.getStats();
  }

  async cleanup() {
    await this.stateService.cleanup();
  }
}

module.exports = StateManager;
