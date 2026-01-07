const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const PolicyService = require('../src/services/PolicyService.cjs');
const StateService = require('../src/services/StateService.cjs');
const ToolError = require('../src/errors/ToolError.cjs');

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
