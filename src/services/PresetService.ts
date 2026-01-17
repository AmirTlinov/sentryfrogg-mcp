#!/usr/bin/env node
// @ts-nocheck

/**
 * 🎛️ Preset storage (JSON file).
 */

const fs = require('fs/promises');
const { resolvePresetsPath } = require('../utils/paths');
const { atomicWriteTextFile } = require('../utils/fsAtomic');
const ToolError = require('../errors/ToolError');

class PresetService {
  constructor(logger) {
    this.logger = logger.child('presets');
    this.filePath = resolvePresetsPath();
    this.presets = new Map();
    this.stats = {
      loaded: 0,
      saved: 0,
      created: 0,
      updated: 0,
      errors: 0,
    };
    this.initPromise = this.load();
  }

  async initialize() {
    await this.initPromise;
  }

  async load() {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      for (const [tool, entries] of Object.entries(parsed || {})) {
        const bucket = new Map();
        if (entries && typeof entries === 'object') {
          for (const [name, preset] of Object.entries(entries)) {
            bucket.set(name, preset);
          }
        }
        this.presets.set(tool, bucket);
      }
      let count = 0;
      for (const bucket of this.presets.values()) {
        count += bucket.size;
      }
      this.stats.loaded = count;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.stats.errors += 1;
        this.logger.warn('Failed to load presets file', { error: error.message });
      }
    }
  }

  async persist() {
    const output = {};
    for (const [tool, bucket] of this.presets.entries()) {
      output[tool] = Object.fromEntries(bucket.entries());
    }
    await atomicWriteTextFile(this.filePath, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
    this.stats.saved += 1;
  }

  async ensureReady() {
    await this.initPromise;
  }

  normalizeTool(tool) {
    if (!tool || typeof tool !== 'string') {
      throw ToolError.invalidParams({ field: 'tool', message: 'tool must be a non-empty string' });
    }
    const trimmed = tool.trim();
    if (!trimmed) {
      throw ToolError.invalidParams({ field: 'tool', message: 'tool must be a non-empty string' });
    }
    return trimmed;
  }

  validatePreset(preset) {
    if (!preset || typeof preset !== 'object' || Array.isArray(preset)) {
      throw ToolError.invalidParams({ field: 'preset', message: 'preset must be an object' });
    }
  }

  getBucket(tool) {
    const bucket = this.presets.get(tool);
    if (bucket) {
      return bucket;
    }
    const created = new Map();
    this.presets.set(tool, created);
    return created;
  }

  async setPreset(tool, name, preset) {
    await this.ensureReady();
    const normalizedTool = this.normalizeTool(tool);
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw ToolError.invalidParams({ field: 'name', message: 'preset name must be a non-empty string' });
    }
    this.validatePreset(preset);

    const trimmedName = name.trim();
    const bucket = this.getBucket(normalizedTool);
    const existing = bucket.get(trimmedName);

    const payload = {
      ...preset,
      updated_at: new Date().toISOString(),
      created_at: existing?.created_at || new Date().toISOString(),
    };

    bucket.set(trimmedName, payload);
    await this.persist();

    if (existing) {
      this.stats.updated += 1;
    } else {
      this.stats.created += 1;
    }

    return { success: true, preset: { tool: normalizedTool, name: trimmedName, ...payload } };
  }

  async getPreset(tool, name) {
    await this.ensureReady();
    const normalizedTool = this.normalizeTool(tool);
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw ToolError.invalidParams({ field: 'name', message: 'preset name must be a non-empty string' });
    }

    const bucket = this.presets.get(normalizedTool);
    const trimmedName = name.trim();
    if (!bucket || !bucket.has(trimmedName)) {
      throw ToolError.notFound({
        code: 'PRESET_NOT_FOUND',
        message: `preset '${trimmedName}' not found for tool '${normalizedTool}'`,
        hint: 'Use action=preset_list to see known presets.',
        details: { tool: normalizedTool, name: trimmedName },
      });
    }

    return { success: true, preset: { tool: normalizedTool, name: trimmedName, ...bucket.get(trimmedName) } };
  }

  async listPresets(tool) {
    await this.ensureReady();

    const output = [];
    const appendBucket = (toolName, bucket) => {
      for (const [name, preset] of bucket.entries()) {
        output.push({
          tool: toolName,
          name,
          description: preset.description,
          created_at: preset.created_at,
          updated_at: preset.updated_at,
        });
      }
    };

    if (tool) {
      const normalizedTool = this.normalizeTool(tool);
      const bucket = this.presets.get(normalizedTool);
      if (bucket) {
        appendBucket(normalizedTool, bucket);
      }
      return { success: true, presets: output };
    }

    for (const [toolName, bucket] of this.presets.entries()) {
      appendBucket(toolName, bucket);
    }

    return { success: true, presets: output };
  }

  async deletePreset(tool, name) {
    await this.ensureReady();
    const normalizedTool = this.normalizeTool(tool);
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw ToolError.invalidParams({ field: 'name', message: 'preset name must be a non-empty string' });
    }

    const bucket = this.presets.get(normalizedTool);
    const trimmedName = name.trim();
    if (!bucket || !bucket.delete(trimmedName)) {
      throw ToolError.notFound({
        code: 'PRESET_NOT_FOUND',
        message: `preset '${trimmedName}' not found for tool '${normalizedTool}'`,
        hint: 'Use action=preset_list to see known presets.',
        details: { tool: normalizedTool, name: trimmedName },
      });
    }

    await this.persist();
    return { success: true, preset: { tool: normalizedTool, name: trimmedName } };
  }

  async resolvePreset(tool, name) {
    await this.ensureReady();
    if (!tool || !name) {
      return null;
    }
    const normalizedTool = String(tool).trim();
    const trimmedName = String(name).trim();
    if (!normalizedTool || !trimmedName) {
      return null;
    }
    const bucket = this.presets.get(normalizedTool);
    if (!bucket) {
      return null;
    }
    return bucket.get(trimmedName) || null;
  }

  getStats() {
    let total = 0;
    for (const bucket of this.presets.values()) {
      total += bucket.size;
    }
    return { ...this.stats, total };
  }

  async cleanup() {
    this.presets.clear();
  }
}

module.exports = PresetService;
