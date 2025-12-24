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
    clientInfo: { name: 'help-test', version: '1.0.0' },
  },
};

function callTool(id, name, args) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: args },
  };
}

function parseToolEnvelope(resp) {
  assert.equal(resp.jsonrpc, '2.0');
  assert.ok(resp.result);
  assert.ok(Array.isArray(resp.result.content));
  const text = resp.result.content[0].text;
  return JSON.parse(text);
}

test('help returns actions for tools and supports tool/action drill-down', async () => {
  const proc = startServer();
  try {
    proc.stdin.write(JSON.stringify(MCP_INIT) + '\n');
    JSON.parse(await readLine(proc.stdout));

    proc.stdin.write(JSON.stringify(callTool(2, 'help', {})) + '\n');
    const root = parseToolEnvelope(JSON.parse(await readLine(proc.stdout)));
    assert.equal(root.ok, true);
    assert.ok(root.result.tools.some((t) => t.name === 'mcp_ssh_manager'));
    const sshEntry = root.result.tools.find((t) => t.name === 'mcp_ssh_manager');
    assert.ok(Array.isArray(sshEntry.actions));
    assert.ok(sshEntry.actions.includes('exec'));

    proc.stdin.write(JSON.stringify(callTool(3, 'help', { tool: 'mcp_ssh_manager' })) + '\n');
    const sshHelp = parseToolEnvelope(JSON.parse(await readLine(proc.stdout)));
    assert.equal(sshHelp.ok, true);
    assert.ok(Array.isArray(sshHelp.result.actions));
    assert.ok(sshHelp.result.actions.includes('authorized_keys_add'));

    proc.stdin.write(JSON.stringify(callTool(4, 'help', { tool: 'ssh', action: 'exec' })) + '\n');
    const sshExec = parseToolEnvelope(JSON.parse(await readLine(proc.stdout)));
    assert.equal(sshExec.ok, true);
    assert.equal(sshExec.result.action, 'exec');
    assert.equal(sshExec.result.example.action, 'exec');
    assert.ok(typeof sshExec.result.example.command === 'string');
  } finally {
    await terminate(proc);
  }
});

