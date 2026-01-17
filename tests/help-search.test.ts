// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';

import { startServer, readLine, terminate } from './util';

const MCP_INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'help-search-test', version: '1.0.0' },
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
  assert.equal(resp.result.content[0].type, 'text');
  return resp.result.content[0].text;
}

test('help query finds ssh exec_follow action', async () => {
  const proc = startServer();
  try {
    proc.stdin.write(JSON.stringify(MCP_INIT) + '\n');
    JSON.parse(await readLine(proc.stdout));

    proc.stdin.write(JSON.stringify(callTool(2, 'help', { query: 'exec_follow', limit: 25 })) + '\n');
    const raw = parseToolText(JSON.parse(await readLine(proc.stdout)));
    const envelope = JSON.parse(raw);
    assert.equal(envelope.success, true);
    assert.ok(envelope.result);
    assert.equal(envelope.result.query, 'exec_follow');
    assert.ok(Array.isArray(envelope.result.results));
    assert.ok(envelope.result.results.some((item) => item.kind === 'action' && item.tool === 'mcp_ssh_manager' && item.action === 'exec_follow'));
  } finally {
    await terminate(proc);
  }
});

test('help query includes user aliases', async () => {
  const proc = startServer();
  try {
    proc.stdin.write(JSON.stringify(MCP_INIT) + '\n');
    JSON.parse(await readLine(proc.stdout));

    proc.stdin.write(JSON.stringify(callTool(2, 'mcp_alias', {
      action: 'alias_upsert',
      name: 'deploy',
      alias: {
        tool: 'ssh',
        args: { action: 'exec', target: 'prod', command: 'uname -a' },
        description: 'deploy shortcut',
      },
    })) + '\n');

    const upsert = JSON.parse(await readLine(proc.stdout));
    assert.equal(upsert.jsonrpc, '2.0');
    assert.ok(upsert.result);

    proc.stdin.write(JSON.stringify(callTool(3, 'help', { query: 'deploy', limit: 25 })) + '\n');
    const raw = parseToolText(JSON.parse(await readLine(proc.stdout)));
    const envelope = JSON.parse(raw);
    assert.equal(envelope.success, true);
    assert.ok(envelope.result);
    assert.equal(envelope.result.query, 'deploy');
    assert.ok(Array.isArray(envelope.result.results));
    assert.ok(envelope.result.results.some((item) => item.kind === 'alias' && item.alias === 'deploy' && item.tool));
  } finally {
    await terminate(proc);
  }
});

