// @ts-nocheck
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const RunbookService = require('../src/services/RunbookService');
const StateService = require('../src/services/StateService');
const RunbookManager = require('../src/managers/RunbookManager');

const loggerStub = {
  child() {
    return this;
  },
  info() {},
  warn() {},
  error() {},
};

test('RunbookManager resolves templates and forwards args to tools', async (t) => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sentryfrogg-runbooks-'));
  const previousRunbooks = process.env.MCP_RUNBOOKS_PATH;
  const previousState = process.env.MCP_STATE_PATH;
  process.env.MCP_RUNBOOKS_PATH = path.join(tmpRoot, 'runbooks.json');
  process.env.MCP_STATE_PATH = path.join(tmpRoot, 'state.json');

  t.after(async () => {
    if (previousRunbooks === undefined) {
      delete process.env.MCP_RUNBOOKS_PATH;
    } else {
      process.env.MCP_RUNBOOKS_PATH = previousRunbooks;
    }
    if (previousState === undefined) {
      delete process.env.MCP_STATE_PATH;
    } else {
      process.env.MCP_STATE_PATH = previousState;
    }
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  const runbookPayload = {
    'demo.echo': {
      description: 'Template resolution smoke test',
      steps: [
        {
          id: 'first',
          tool: 'mcp_api_client',
          args: {
            action: 'request',
            url: 'https://example.com/{{ input.path }}',
            optional: '{{ ?input.optional }}',
          },
        },
        {
          id: 'second',
          tool: 'mcp_api_client',
          args: {
            action: 'request',
            url: '{{ steps.first.received.url }}?ok=1',
          },
        },
      ],
    },
  };

  await fs.writeFile(process.env.MCP_RUNBOOKS_PATH, `${JSON.stringify(runbookPayload, null, 2)}\n`);

  const runbookService = new RunbookService(loggerStub);
  await runbookService.initialize();
  const stateService = new StateService(loggerStub);
  await stateService.initialize();

  const calls = [];
  const toolExecutor = {
    async execute(tool, args) {
      calls.push({ tool, args });
      return { result: { received: args }, meta: { tool } };
    },
  };

  const manager = new RunbookManager(loggerStub, runbookService, stateService, toolExecutor);
  const result = await manager.handleAction({
    action: 'runbook_run',
    name: 'demo.echo',
    input: { path: 'status' },
    trace_id: 'trace-1',
    span_id: 'span-1',
  });

  assert.equal(result.success, true);
  assert.equal(result.steps.length, 2);

  assert.equal(calls[0].tool, 'mcp_api_client');
  assert.equal(calls[0].args.url, 'https://example.com/status');
  assert.equal(calls[0].args.optional, '');
  assert.equal(calls[0].args.trace_id, 'trace-1');
  assert.equal(calls[0].args.parent_span_id, 'span-1');

  assert.equal(calls[1].args.url, 'https://example.com/status?ok=1');
});

test('RunbookManager retries a step until retry.until matches', async (t) => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sentryfrogg-runbooks-'));
  const previousRunbooks = process.env.MCP_RUNBOOKS_PATH;
  const previousState = process.env.MCP_STATE_PATH;
  process.env.MCP_RUNBOOKS_PATH = path.join(tmpRoot, 'runbooks.json');
  process.env.MCP_STATE_PATH = path.join(tmpRoot, 'state.json');

  t.after(async () => {
    if (previousRunbooks === undefined) {
      delete process.env.MCP_RUNBOOKS_PATH;
    } else {
      process.env.MCP_RUNBOOKS_PATH = previousRunbooks;
    }
    if (previousState === undefined) {
      delete process.env.MCP_STATE_PATH;
    } else {
      process.env.MCP_STATE_PATH = previousState;
    }
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  const runbookPayload = {
    'demo.retry': {
      description: 'Retry engine smoke test',
      steps: [
        {
          id: 'probe',
          tool: 'mcp_api_client',
          retry: {
            max_attempts: 5,
            delay_ms: 0,
            until: { path: 'result.attempt', gte: 3 },
          },
          args: {
            action: 'request',
            url: 'https://example.com',
          },
        },
      ],
    },
  };

  await fs.writeFile(process.env.MCP_RUNBOOKS_PATH, `${JSON.stringify(runbookPayload, null, 2)}\n`);

  const runbookService = new RunbookService(loggerStub);
  await runbookService.initialize();
  const stateService = new StateService(loggerStub);
  await stateService.initialize();

  let attempt = 0;
  const toolExecutor = {
    async execute() {
      attempt += 1;
      return { result: { attempt }, meta: {} };
    },
  };

  const manager = new RunbookManager(loggerStub, runbookService, stateService, toolExecutor);
  const result = await manager.handleAction({
    action: 'runbook_run',
    name: 'demo.retry',
    input: {},
  });

  assert.equal(result.success, true);
  assert.equal(attempt, 3);
  assert.equal(result.steps[0].retry.attempts, 3);
});

test('RunbookManager fails when retry condition is not satisfied in time', async (t) => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sentryfrogg-runbooks-'));
  const previousRunbooks = process.env.MCP_RUNBOOKS_PATH;
  const previousState = process.env.MCP_STATE_PATH;
  process.env.MCP_RUNBOOKS_PATH = path.join(tmpRoot, 'runbooks.json');
  process.env.MCP_STATE_PATH = path.join(tmpRoot, 'state.json');

  t.after(async () => {
    if (previousRunbooks === undefined) {
      delete process.env.MCP_RUNBOOKS_PATH;
    } else {
      process.env.MCP_RUNBOOKS_PATH = previousRunbooks;
    }
    if (previousState === undefined) {
      delete process.env.MCP_STATE_PATH;
    } else {
      process.env.MCP_STATE_PATH = previousState;
    }
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  const runbookPayload = {
    'demo.retry.fail': {
      description: 'Retry failure',
      steps: [
        {
          id: 'probe',
          tool: 'mcp_api_client',
          retry: {
            max_attempts: 2,
            delay_ms: 0,
            until: { path: 'result.ready', equals: true },
          },
          args: {
            action: 'request',
            url: 'https://example.com',
          },
        },
      ],
    },
  };

  await fs.writeFile(process.env.MCP_RUNBOOKS_PATH, `${JSON.stringify(runbookPayload, null, 2)}\n`);

  const runbookService = new RunbookService(loggerStub);
  await runbookService.initialize();
  const stateService = new StateService(loggerStub);
  await stateService.initialize();

  let attempt = 0;
  const toolExecutor = {
    async execute() {
      attempt += 1;
      return { result: { ready: false, attempt }, meta: {} };
    },
  };

  const manager = new RunbookManager(loggerStub, runbookService, stateService, toolExecutor);
  const result = await manager.handleAction({
    action: 'runbook_run',
    name: 'demo.retry.fail',
    input: {},
  });

  assert.equal(result.success, false);
  assert.equal(attempt, 2);
  assert.ok(result.error);
});
