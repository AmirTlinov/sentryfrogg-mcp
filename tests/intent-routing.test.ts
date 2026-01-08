// @ts-nocheck
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const CapabilityService = require('../src/services/CapabilityService');
const EvidenceService = require('../src/services/EvidenceService');
const IntentManager = require('../src/managers/IntentManager');

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
  ensureOptionalString(value, label) {
    if (value === undefined || value === null) {
      return undefined;
    }
    return this.ensureString(value, label);
  },
  ensureObject(value, label) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`${label} must be an object`);
    }
    return value;
  },
  ensureOptionalObject(value, label) {
    if (value === undefined || value === null) {
      return undefined;
    }
    return this.ensureObject(value, label);
  },
};

test('IntentManager selects among multiple capabilities for the same intent via when tags', async (t) => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sentryfrogg-intent-routing-'));
  const previousCapabilities = process.env.MCP_CAPABILITIES_PATH;
  const previousEvidence = process.env.MCP_EVIDENCE_DIR;
  process.env.MCP_CAPABILITIES_PATH = path.join(tmpRoot, 'capabilities.json');
  process.env.MCP_EVIDENCE_DIR = path.join(tmpRoot, 'evidence');

  t.after(async () => {
    if (previousCapabilities === undefined) {
      delete process.env.MCP_CAPABILITIES_PATH;
    } else {
      process.env.MCP_CAPABILITIES_PATH = previousCapabilities;
    }
    if (previousEvidence === undefined) {
      delete process.env.MCP_EVIDENCE_DIR;
    } else {
      process.env.MCP_EVIDENCE_DIR = previousEvidence;
    }
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  const capabilityService = new CapabilityService(loggerStub, securityStub);
  await capabilityService.initialize();

  await capabilityService.setCapability('gitops.plan.argocd', {
    intent: 'gitops.plan',
    runbook: 'gitops.plan.argocd',
    effects: { kind: 'read' },
    inputs: { required: [] },
    when: { tags_any: ['argocd'] },
  });

  await capabilityService.setCapability('gitops.plan.flux', {
    intent: 'gitops.plan',
    runbook: 'gitops.plan.flux',
    effects: { kind: 'read' },
    inputs: { required: [] },
    when: { tags_any: ['flux'] },
  });

  const contextServiceStub = {
    async getContext() {
      return { context: { key: 'demo', root: tmpRoot, tags: ['flux'] } };
    },
  };

  const runbookManagerStub = {
    handleAction: async () => ({ success: true, steps: [] }),
  };

  const evidenceService = new EvidenceService(loggerStub, securityStub);
  const intentManager = new IntentManager(
    loggerStub,
    securityStub,
    validationStub,
    capabilityService,
    runbookManagerStub,
    evidenceService,
    null,
    contextServiceStub
  );

  const compiled = await intentManager.handleAction({
    action: 'compile',
    intent: { type: 'gitops.plan', inputs: {} },
  });

  assert.equal(compiled.plan.steps[0].runbook, 'gitops.plan.flux');
});

test('IntentManager propagates apply into runbook inputs', async (t) => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sentryfrogg-intent-apply-'));
  const previousCapabilities = process.env.MCP_CAPABILITIES_PATH;
  const previousEvidence = process.env.MCP_EVIDENCE_DIR;
  process.env.MCP_CAPABILITIES_PATH = path.join(tmpRoot, 'capabilities.json');
  process.env.MCP_EVIDENCE_DIR = path.join(tmpRoot, 'evidence');

  t.after(async () => {
    if (previousCapabilities === undefined) {
      delete process.env.MCP_CAPABILITIES_PATH;
    } else {
      process.env.MCP_CAPABILITIES_PATH = previousCapabilities;
    }
    if (previousEvidence === undefined) {
      delete process.env.MCP_EVIDENCE_DIR;
    } else {
      process.env.MCP_EVIDENCE_DIR = previousEvidence;
    }
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  const capabilityService = new CapabilityService(loggerStub, securityStub);
  await capabilityService.initialize();
  await capabilityService.setCapability('k8s.apply', {
    intent: 'k8s.apply',
    runbook: 'k8s.apply',
    inputs: { required: [] },
    effects: { kind: 'write', requires_apply: true },
  });

  let sawApply = false;
  const runbookManagerStub = {
    handleAction: async (args) => {
      sawApply = args.input?.apply === true;
      return { success: true, steps: [] };
    },
  };

  const contextServiceStub = {
    async getContext() {
      return { context: { key: 'demo', root: tmpRoot, tags: ['k8s'] } };
    },
  };

  const evidenceService = new EvidenceService(loggerStub, securityStub);
  const intentManager = new IntentManager(
    loggerStub,
    securityStub,
    validationStub,
    capabilityService,
    runbookManagerStub,
    evidenceService,
    null,
    contextServiceStub
  );

  const executed = await intentManager.handleAction({
    action: 'execute',
    apply: true,
    intent: { type: 'k8s.apply', inputs: {} },
  });

  assert.equal(executed.success, true);
  assert.equal(sawApply, true);
});
