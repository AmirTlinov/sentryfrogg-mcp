// @ts-nocheck
const test = require('node:test');
const assert = require('node:assert/strict');

const RunbookManager = require('../src/managers/RunbookManager');
const { parseRunbookDsl } = require('../src/utils/runbookDsl');

const loggerStub = {
  child() {
    return this;
  },
  warn() {},
  info() {},
  error() {},
};

const stateServiceStub = () => ({
  state: {},
  async set(key, value) {
    this.state[key] = value;
  },
  async dump() {
    return { state: { ...this.state } };
  },
});

const runbookServiceStub = () => ({
  async getRunbook() {
    throw new Error('not used');
  },
  async setRunbook() {},
  async listRunbooks() {
    return { success: true, runbooks: [] };
  },
  async deleteRunbook() {},
});

test('parseRunbookDsl builds a runbook', () => {
  const dsl = `runbook sample\nstep ping mcp_api_client request\narg url=https://{{input.host}}/health`;
  const runbook = parseRunbookDsl(dsl);
  assert.equal(runbook.name, 'sample');
  assert.equal(runbook.steps.length, 1);
  assert.equal(runbook.steps[0].tool, 'mcp_api_client');
  assert.equal(runbook.steps[0].args.action, 'request');
  assert.equal(runbook.steps[0].args.url, 'https://{{input.host}}/health');
});

test('RunbookManager executes DSL runs', async () => {
  const toolExecutor = {
    async execute(tool, args) {
      return { result: { tool, args }, meta: { tool } };
    },
  };

  const manager = new RunbookManager(
    loggerStub,
    runbookServiceStub(),
    stateServiceStub(),
    toolExecutor
  );

  const dsl = `step ping mcp_api_client request\narg url=https://{{input.host}}/health`;
  const result = await manager.handleAction({
    action: 'runbook_run_dsl',
    dsl,
    input: { host: 'example.com' },
  });

  assert.equal(result.success, true);
  assert.equal(result.steps[0].result.args.url, 'https://example.com/health');
});
