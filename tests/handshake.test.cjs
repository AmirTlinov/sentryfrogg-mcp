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
    clientInfo: { name: 'handshake-test', version: '1.0.0' },
  },
};

const MCP_LIST = {
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/list',
};
test('STDIO handshake returns initialize response and tools list', async () => {
  const proc = startServer();

  try {
    proc.stdin.write(JSON.stringify(MCP_INIT) + '\n');
    const initResp = JSON.parse(await readLine(proc.stdout));
    assert.equal(initResp.id, 1);
    assert.equal(initResp.result.protocolVersion, '2025-06-18');
    assert.equal(initResp.result.capabilities.tools.list, true);
    assert.equal(initResp.result.capabilities.tools.call, true);

    proc.stdin.write(JSON.stringify(MCP_LIST) + '\n');
    const listResp = JSON.parse(await readLine(proc.stdout));
    assert.equal(listResp.id, 2);
    assert.ok(Array.isArray(listResp.result.tools));
    assert.ok(listResp.result.tools.length >= 4);
  } finally {
    await terminate(proc);
  }
});
