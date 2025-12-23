const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, readLine, terminate } = require('./util.cjs');

const MCP_INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'handshake-local-test', version: '1.0.0' },
  },
};

const MCP_LIST = {
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/list',
};

async function listToolNames(proc) {
  proc.stdin.write(JSON.stringify(MCP_INIT) + '\n');
  await readLine(proc.stdout);
  proc.stdin.write(JSON.stringify(MCP_LIST) + '\n');
  const listResp = JSON.parse(await readLine(proc.stdout));
  return listResp.result.tools.map((tool) => tool.name);
}

test('tools/list does not expose mcp_local when unsafe is disabled', async () => {
  const proc = startServer();
  try {
    const names = await listToolNames(proc);
    assert.ok(!names.includes('mcp_local'));
    assert.ok(!names.includes('local'));
  } finally {
    await terminate(proc);
  }
});

test('tools/list exposes mcp_local when unsafe is enabled', async () => {
  const proc = startServer([], { SENTRYFROGG_UNSAFE_LOCAL: '1' });
  try {
    const names = await listToolNames(proc);
    assert.ok(names.includes('mcp_local'));
    assert.ok(names.includes('local'));
  } finally {
    await terminate(proc);
  }
});

