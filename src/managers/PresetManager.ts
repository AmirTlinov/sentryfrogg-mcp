#!/usr/bin/env node
// @ts-nocheck

/**
 * 🎛️ Preset manager.
 */

const { unknownActionError } = require('../utils/toolErrors');

const PRESET_ACTIONS = ['preset_upsert', 'preset_get', 'preset_list', 'preset_delete'];

class PresetManager {
  constructor(logger, presetService) {
    this.logger = logger.child('preset');
    this.presetService = presetService;
  }

  async handleAction(args = {}) {
    const { action } = args;

    switch (action) {
      case 'preset_upsert':
        return this.presetService.setPreset(args.tool, args.name, args.preset || args);
      case 'preset_get':
        return this.presetService.getPreset(args.tool, args.name);
      case 'preset_list':
        return this.presetService.listPresets(args.tool);
      case 'preset_delete':
        return this.presetService.deletePreset(args.tool, args.name);
      default:
        throw unknownActionError({ tool: 'preset', action, knownActions: PRESET_ACTIONS });
    }
  }

  getStats() {
    return this.presetService.getStats();
  }

  async cleanup() {
    await this.presetService.cleanup();
  }
}

module.exports = PresetManager;
