// @ts-nocheck
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const CapabilityService = require('../src/services/CapabilityService');
const CapabilityManager = require('../src/managers/CapabilityManager');

const loggerStub = {
  child() {
    return this;
  },
  info() {},
  warn() {},
  error() {},
};

const securityStub = {
  ensureSizeFits() {},
};

const validationStub = {
  ensureString(value, label) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`${label} must be a non-empty string`);
    }
    return value.trim();
  },
  ensureObject(value, label) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`${label} must be an object`);
    }
    return value;
  },
};

test('CapabilityManager suggests capabilities by context tags', async (t) => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sentryfrogg-capability-'));
  const previousCapabilities = process.env.MCP_CAPABILITIES_PATH;
  process.env.MCP_CAPABILITIES_PATH = path.join(tmpRoot, 'capabilities.json');

  t.after(async () => {
    if (previousCapabilities === undefined) {
      delete process.env.MCP_CAPABILITIES_PATH;
    } else {
      process.env.MCP_CAPABILITIES_PATH = previousCapabilities;
    }
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  const capabilityService = new CapabilityService(loggerStub, securityStub);
  await capabilityService.initialize();

  const contextServiceStub = {
    async getContext() {
      return { context: { key: 'demo', root: tmpRoot, tags: ['k8s'] } };
    },
  };

  const manager = new CapabilityManager(
    loggerStub,
    securityStub,
    validationStub,
    capabilityService,
    contextServiceStub
  );

  await manager.handleAction({
    action: 'set',
    name: 'k8s.diff',
    capability: {
      intent: 'k8s.diff',
      runbook: 'k8s.diff',
      effects: { kind: 'read' },
      inputs: { required: ['overlay'] },
      when: { tags_any: ['k8s'] },
    },
  });

  await manager.handleAction({
    action: 'set',
    name: 'tf.plan',
    capability: {
      intent: 'tf.plan',
      runbook: 'tf.plan',
      effects: { kind: 'read' },
      inputs: { required: [] },
      when: { tags_any: ['terraform'] },
    },
  });

  const suggestion = await manager.handleAction({ action: 'suggest' });
  assert.ok(suggestion.suggestions.some((item) => item.name === 'k8s.diff'));
});
