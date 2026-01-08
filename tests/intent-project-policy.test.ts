// @ts-nocheck
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const CapabilityService = require('../src/services/CapabilityService');
const EvidenceService = require('../src/services/EvidenceService');
const StateService = require('../src/services/StateService');
const PolicyService = require('../src/services/PolicyService');
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
    return this.ensureString(String(value), label);
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

test('IntentManager resolves target.policy and target.* mappings even when project/target are provided', async (t) => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sentryfrogg-intent-policy-'));
  const previousCapabilities = process.env.MCP_CAPABILITIES_PATH;
  const previousEvidence = process.env.MCP_EVIDENCE_DIR;
  const previousState = process.env.MCP_STATE_PATH;
  process.env.MCP_CAPABILITIES_PATH = path.join(tmpRoot, 'capabilities.json');
  process.env.MCP_EVIDENCE_DIR = path.join(tmpRoot, 'evidence');
  process.env.MCP_STATE_PATH = path.join(tmpRoot, 'state.json');

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
    if (previousState === undefined) {
      delete process.env.MCP_STATE_PATH;
    } else {
      process.env.MCP_STATE_PATH = previousState;
    }
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  const capabilityService = new CapabilityService(loggerStub, securityStub);
  await capabilityService.initialize();
  await capabilityService.setCapability('gitops.propose', {
    intent: 'gitops.propose',
    runbook: 'noop',
    when: null,
    inputs: {
      required: ['patch', 'message', 'kubeconfig'],
      map: {
        kubeconfig: 'target.kubeconfig',
      },
    },
    effects: { kind: 'write', requires_apply: true },
  });

  const runbookManagerStub = {
    handleAction: async () => ({ success: true, steps: [] }),
  };

  let resolverCalls = 0;
  const projectResolverStub = {
    async resolveContext(args) {
      resolverCalls += 1;
      assert.equal(args.project, 'demo');
      assert.equal(args.target, 'prod');
      return {
        projectName: 'demo',
        targetName: 'prod',
        project: {},
        target: {
          kubeconfig: '/tmp/kubeconfig',
          policy: { mode: 'operatorless', lock: { enabled: false } },
        },
      };
    },
  };

  const stateService = new StateService(loggerStub);
  await stateService.initialize();
  const policyService = new PolicyService(loggerStub, validationStub, stateService);
  const evidenceService = new EvidenceService(loggerStub, securityStub);

  const intentManager = new IntentManager(
    loggerStub,
    securityStub,
    validationStub,
    capabilityService,
    runbookManagerStub,
    evidenceService,
    projectResolverStub,
    null,
    policyService
  );

  const executed = await intentManager.handleAction({
    action: 'execute',
    apply: true,
    project: 'demo',
    target: 'prod',
    intent: {
      type: 'gitops.propose',
      inputs: {
        patch: 'diff --git a/a b/a\n',
        message: 'test',
      },
    },
  });

  assert.equal(executed.success, true);
  assert.equal(resolverCalls, 1);
  assert.equal(executed.plan.steps[0].inputs.kubeconfig, '/tmp/kubeconfig');
});
