// @ts-nocheck
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const PresetService = require('../src/services/PresetService');
const ToolExecutor = require('../src/services/ToolExecutor');

const loggerStub = {
  child() {
    return this;
  },
  warn() {},
  info() {},
  error() {},
};

function createTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'sentryfrogg-preset-'));
}

test('PresetService stores and merges presets in ToolExecutor', async () => {
  const dir = await createTempDir();
  const original = process.env.MCP_PROFILES_DIR;
  process.env.MCP_PROFILES_DIR = dir;

  const presetService = new PresetService(loggerStub);
  await presetService.initialize();

  await presetService.setPreset('mcp_api_client', 'base', {
    headers: { 'X-Test': 'one' },
    method: 'GET',
  });

  const stateService = {
    async set() {},
  };

  const executor = new ToolExecutor(
    loggerStub,
    stateService,
    null,
    presetService,
    null,
    {
      mcp_api_client: async (args) => ({ args }),
    }
  );

  const payload = await executor.execute('mcp_api_client', {
    preset: 'base',
    headers: { 'X-Other': 'two' },
  });

  assert.equal(payload.meta.preset, 'base');
  assert.equal(payload.result.args.headers['X-Test'], 'one');
  assert.equal(payload.result.args.headers['X-Other'], 'two');
  assert.equal(payload.result.args.preset, undefined);
  assert.equal(typeof payload.meta.trace_id, 'string');
  assert.equal(typeof payload.meta.span_id, 'string');

  process.env.MCP_PROFILES_DIR = original;
  await fs.rm(dir, { recursive: true, force: true });
});
