// @ts-nocheck
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const PolicyService = require('../src/services/PolicyService');
const StateService = require('../src/services/StateService');
const ToolError = require('../src/errors/ToolError');

const loggerStub = {
  child() {
    return this;
  },
  info() {},
  warn() {},
  error() {},
};

test('PolicyService environment lock is re-entrant (ref-counted)', async (t) => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sentryfrogg-policy-'));
  const prevProfiles = process.env.MCP_PROFILES_DIR;
  process.env.MCP_PROFILES_DIR = tmpRoot;

  t.after(async () => {
    if (prevProfiles === undefined) {
      delete process.env.MCP_PROFILES_DIR;
    } else {
      process.env.MCP_PROFILES_DIR = prevProfiles;
    }
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  const stateService = new StateService(loggerStub);
  await stateService.initialize();
  const policyService = new PolicyService(loggerStub, {}, stateService);

  const key = 'gitops.lock.test';
  await policyService.acquireLock({ key, traceId: 'trace-1', ttlMs: 1000, meta: {} });
  await policyService.acquireLock({ key, traceId: 'trace-1', ttlMs: 1000, meta: {} });

  const locked = await stateService.get(key, 'persistent');
  assert.equal(locked.value.trace_id, 'trace-1');
  assert.equal(locked.value.count, 2);

  await policyService.releaseLock({ key, traceId: 'trace-1' });
  const stillHeld = await stateService.get(key, 'persistent');
  assert.equal(stillHeld.value.count, 1);

  await policyService.releaseLock({ key, traceId: 'trace-1' });
  const cleared = await stateService.get(key, 'persistent');
  assert.equal(cleared.value, undefined);
});

test('PolicyService denies GitOps write without policy', async () => {
  const prevAutonomyPolicy = process.env.SENTRYFROGG_AUTONOMY_POLICY;
  const prevAutonomyFlag = process.env.SENTRYFROGG_AUTONOMY;
  delete process.env.SENTRYFROGG_AUTONOMY_POLICY;
  delete process.env.SENTRYFROGG_AUTONOMY;

  const stateService = { get: async () => ({ value: undefined }), set: async () => {}, unset: async () => {} };
  const policyService = new PolicyService(loggerStub, {}, stateService);

  await assert.rejects(
    () =>
      policyService.guardGitOpsWrite({
        intentType: 'gitops.propose',
        inputs: { merge: true },
        traceId: 'trace-1',
        repoRoot: '/tmp/repo',
      }),
    (error) => {
      assert.equal(ToolError.isToolError(error), true);
      assert.equal(error.kind, 'denied');
      assert.equal(error.code, 'POLICY_REQUIRED');
      return true;
    }
  );

  if (prevAutonomyPolicy === undefined) {
    delete process.env.SENTRYFROGG_AUTONOMY_POLICY;
  } else {
    process.env.SENTRYFROGG_AUTONOMY_POLICY = prevAutonomyPolicy;
  }
  if (prevAutonomyFlag === undefined) {
    delete process.env.SENTRYFROGG_AUTONOMY;
  } else {
    process.env.SENTRYFROGG_AUTONOMY = prevAutonomyFlag;
  }
});

test('PolicyService honors autonomy policy env for GitOps writes', async (t) => {
  const prevAutonomyPolicy = process.env.SENTRYFROGG_AUTONOMY_POLICY;
  const prevAutonomyFlag = process.env.SENTRYFROGG_AUTONOMY;

  process.env.SENTRYFROGG_AUTONOMY_POLICY = 'operatorless';
  delete process.env.SENTRYFROGG_AUTONOMY;

  t.after(() => {
    if (prevAutonomyPolicy === undefined) {
      delete process.env.SENTRYFROGG_AUTONOMY_POLICY;
    } else {
      process.env.SENTRYFROGG_AUTONOMY_POLICY = prevAutonomyPolicy;
    }
    if (prevAutonomyFlag === undefined) {
      delete process.env.SENTRYFROGG_AUTONOMY;
    } else {
      process.env.SENTRYFROGG_AUTONOMY = prevAutonomyFlag;
    }
  });

  const stateService = { get: async () => ({ value: undefined }), set: async () => {}, unset: async () => {} };
  const policyService = new PolicyService(loggerStub, {}, stateService);

  const guard = await policyService.guardGitOpsWrite({
    intentType: 'gitops.propose',
    inputs: { merge: false },
    traceId: 'trace-1',
    repoRoot: '/tmp/repo',
  });

  assert.equal(guard.policy.mode, 'operatorless');
});

test('PolicyService enforces change window when configured', async () => {
  const stateService = { get: async () => ({ value: undefined }), set: async () => {}, unset: async () => {} };
  const policyService = new PolicyService(loggerStub, {}, stateService);

  await assert.rejects(
    () =>
      policyService.guardGitOpsWrite({
        intentType: 'gitops.sync',
        inputs: {
          namespace: 'argocd',
          policy: {
            mode: 'operatorless',
            lock: { enabled: false },
            change_windows: [],
          },
        },
        traceId: 'trace-1',
        repoRoot: '/tmp/repo',
      }),
    (error) => {
      assert.equal(ToolError.isToolError(error), true);
      assert.equal(error.kind, 'denied');
      assert.equal(error.code, 'POLICY_CHANGE_WINDOW');
      return true;
    }
  );
});

test('PolicyService resolves policy profile names from project context', async () => {
  const stateService = { get: async () => ({ value: undefined }), set: async () => {}, unset: async () => {} };
  const policyService = new PolicyService(loggerStub, {}, stateService);

  const guard = await policyService.guardGitOpsWrite({
    intentType: 'gitops.propose',
    inputs: { policy: 'autonomy', merge: false },
    traceId: 'trace-1',
    repoRoot: '/tmp/repo',
    projectContext: {
      project: {
        policy_profiles: {
          autonomy: { mode: 'operatorless' },
        },
      },
      target: {},
    },
  });

  assert.equal(guard.policy.mode, 'operatorless');
});
