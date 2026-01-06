const test = require('node:test');
const assert = require('node:assert/strict');

const WorkspaceManager = require('../src/managers/WorkspaceManager.cjs');

const loggerStub = {
  child() {
    return this;
  },
  info() {},
  warn() {},
  error() {},
};

const validationStub = {
  ensureString(value) {
    return String(value);
  },
};

test('WorkspaceManager cleanup triggers cleanup on runbook and ssh managers', async () => {
  let runbookCleanups = 0;
  let sshCleanups = 0;

  const runbookManagerStub = {
    async cleanup() {
      runbookCleanups += 1;
    },
    async handleAction() {
      return { success: true };
    },
  };

  const sshManagerStub = {
    async cleanup() {
      sshCleanups += 1;
    },
  };

  const workspaceServiceStub = {
    summarize() {
      return { success: true };
    },
    suggest() {
      return { success: true };
    },
    diagnose() {
      return { success: true };
    },
    getStoreStatus() {
      return { success: true };
    },
    migrateLegacy() {
      return { success: true };
    },
    getStats() {
      return { success: true };
    },
  };

  const manager = new WorkspaceManager(
    loggerStub,
    validationStub,
    workspaceServiceStub,
    runbookManagerStub,
    null,
    sshManagerStub
  );

  const result = await manager.handleAction({ action: 'cleanup' });
  assert.equal(result.success, true);
  assert.deepEqual(result.cleaned.sort(), ['runbook', 'ssh']);
  assert.equal(runbookCleanups, 1);
  assert.equal(sshCleanups, 1);
});
