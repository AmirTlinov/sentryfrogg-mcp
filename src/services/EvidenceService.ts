#!/usr/bin/env node
// @ts-nocheck

/**
 * 🧾 Evidence Trail (запись/чтение)
 */

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { resolveEvidenceDir } = require('../utils/paths');
const ToolError = require('../errors/ToolError');

function buildEvidenceId() {
  if (crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
}

function safeTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

class EvidenceService {
  constructor(logger, security) {
    this.logger = logger.child('evidence');
    this.security = security;
    this.baseDir = resolveEvidenceDir();
  }

  async ensureDir() {
    await fs.mkdir(this.baseDir, { recursive: true });
  }

  async saveEvidence(bundle) {
    await this.ensureDir();
    const payload = JSON.stringify(bundle, null, 2);
    this.security.ensureSizeFits(payload);
    const filename = `evidence-${safeTimestamp()}-${buildEvidenceId()}.json`;
    const fullPath = path.join(this.baseDir, filename);
    await fs.writeFile(fullPath, `${payload}\n`, 'utf8');
    return { path: fullPath, id: filename };
  }

  async listEvidence(limit = 20) {
    try {
      const entries = await fs.readdir(this.baseDir, { withFileTypes: true });
      const files = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) => entry.name)
        .sort()
        .reverse();
      return files.slice(0, limit);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  async getEvidence(id) {
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw ToolError.invalidParams({ field: 'id', message: 'Evidence id must be a non-empty string' });
    }
    const filename = path.basename(id.trim());
    const fullPath = path.join(this.baseDir, filename);
    let raw;
    try {
      raw = await fs.readFile(fullPath, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        throw ToolError.notFound({
          code: 'EVIDENCE_NOT_FOUND',
          message: `Evidence not found: ${filename}`,
          hint: 'Use action=evidence_list to see recent evidence bundles.',
          details: { id: filename },
        });
      }
      throw error;
    }
    this.security.ensureSizeFits(raw);
    return { id: filename, path: fullPath, payload: JSON.parse(raw) };
  }
}

module.exports = EvidenceService;
