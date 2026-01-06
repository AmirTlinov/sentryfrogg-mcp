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

function parseToolText(resp) {
  assert.equal(resp.jsonrpc, '2.0');
  assert.ok(resp.result);
  assert.ok(Array.isArray(resp.result.content));
  return resp.result.content[0].text;
}

test('help returns actions for tools and supports tool/action drill-down', async () => {
  const proc = startServer();
  try {
    proc.stdin.write(JSON.stringify(MCP_INIT) + '\n');
    JSON.parse(await readLine(proc.stdout));

    proc.stdin.write(JSON.stringify(callTool(2, 'help', {})) + '\n');
    const root = parseToolText(JSON.parse(await readLine(proc.stdout)));
    assert.ok(root.includes('[DATA]'));
    assert.ok(root.includes('Tools:'));
    assert.ok(root.includes('- mcp_ssh_manager:'));
    assert.ok(root.includes('- legend:'));

    proc.stdin.write(JSON.stringify(callTool(3, 'help', { tool: 'mcp_ssh_manager' })) + '\n');
    const sshHelp = parseToolText(JSON.parse(await readLine(proc.stdout)));
    assert.ok(sshHelp.includes('Actions:'));
    assert.ok(sshHelp.includes('- authorized_keys_add'));

    proc.stdin.write(JSON.stringify(callTool(4, 'help', { tool: 'ssh', action: 'exec' })) + '\n');
    const sshExec = parseToolText(JSON.parse(await readLine(proc.stdout)));
    assert.ok(sshExec.includes("A: help({ tool: 'mcp_ssh_manager', action: 'exec' })"));
    assert.ok(sshExec.includes('```json'));
    assert.ok(sshExec.includes('"action": "exec"'));
    assert.ok(sshExec.includes('"command": "uname -a"'));

    proc.stdin.write(JSON.stringify(callTool(5, 'help', { tool: 'legend' })) + '\n');
    const helpLegend = parseToolText(JSON.parse(await readLine(proc.stdout)));
    assert.ok(helpLegend.includes('A: legend()'));
    assert.ok(helpLegend.includes('Common fields:'));
    assert.ok(helpLegend.includes('- output:'));
    assert.ok(helpLegend.includes('Resolution:'));

    proc.stdin.write(JSON.stringify(callTool(6, 'legend', {})) + '\n');
    const legend = parseToolText(JSON.parse(await readLine(proc.stdout)));
    assert.ok(legend.includes('A: legend()'));
    assert.ok(legend.includes('Golden path:'));
  } finally {
    await terminate(proc);
  }
});
