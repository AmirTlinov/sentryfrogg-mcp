const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const AliasService = require('../src/services/AliasService.cjs');
const ToolExecutor = require('../src/services/ToolExecutor.cjs');

const loggerStub = {
  child() {
    return this;
  },
  warn() {},
  info() {},
  error() {},
};

function createTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'sentryfrogg-alias-'));
}

test('AliasService stores and resolves aliases', async () => {
  const dir = await createTempDir();
  const original = process.env.MCP_PROFILES_DIR;
  process.env.MCP_PROFILES_DIR = dir;

  const service = new AliasService(loggerStub);
  await service.initialize();

  await service.setAlias('short', {
    tool: 'mcp_api_client',
    args: { action: 'request', url: 'https://example.com' },
    description: 'short alias',
  });

  const fetched = await service.getAlias('short');
  assert.equal(fetched.alias.tool, 'mcp_api_client');

  const listed = await service.listAliases();
  assert.equal(listed.aliases.length, 1);
  assert.equal(listed.aliases[0].name, 'short');

  process.env.MCP_PROFILES_DIR = original;
  await fs.rm(dir, { recursive: true, force: true });
});

test('ToolExecutor resolves alias and merges args', async () => {
  const dir = await createTempDir();
  const original = process.env.MCP_PROFILES_DIR;
  process.env.MCP_PROFILES_DIR = dir;

  const aliasService = new AliasService(loggerStub);
  await aliasService.initialize();

  await aliasService.setAlias('short', {
    tool: 'mcp_state',
    args: { action: 'set', key: 'foo', value: 1 },
  });

  const stateService = {
    async set() {},
  };

  const executor = new ToolExecutor(
    loggerStub,
    stateService,
    aliasService,
    null,
    null,
    {
      mcp_state: async (args) => ({ ok: true, args }),
    }
  );

  const payload = await executor.execute('short', { action: 'get', key: 'foo' });
  assert.equal(payload.meta.tool, 'mcp_state');
  assert.equal(payload.meta.invoked_as, 'short');
  assert.equal(payload.result.args.action, 'get');
  assert.equal(payload.result.args.key, 'foo');
  assert.equal(typeof payload.meta.trace_id, 'string');
  assert.equal(typeof payload.meta.span_id, 'string');

  process.env.MCP_PROFILES_DIR = original;
  await fs.rm(dir, { recursive: true, force: true });
});
