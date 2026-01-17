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
    clientInfo: { name: 'did-you-mean-test', version: '1.0.0' },
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

test('help suggests closest tool name', async () => {
  const proc = startServer();
  try {
    proc.stdin.write(JSON.stringify(MCP_INIT) + '\n');
    JSON.parse(await readLine(proc.stdout));

    proc.stdin.write(JSON.stringify(callTool(2, 'help', { tool: 'psq' })) + '\n');
    const raw = parseToolText(JSON.parse(await readLine(proc.stdout)));
    const envelope = JSON.parse(raw);

    assert.equal(envelope.success, true);
    assert.ok(envelope.result);
    assert.ok(typeof envelope.result.error === 'string');
    assert.ok(Array.isArray(envelope.result.did_you_mean));
    assert.ok(envelope.result.did_you_mean.includes('psql'));
  } finally {
    await terminate(proc);
  }
});

test('help suggests closest action name', async () => {
  const proc = startServer();
  try {
    proc.stdin.write(JSON.stringify(MCP_INIT) + '\n');
    JSON.parse(await readLine(proc.stdout));

    proc.stdin.write(JSON.stringify(callTool(2, 'help', { tool: 'ssh', action: 'exec_folow' })) + '\n');
    const raw = parseToolText(JSON.parse(await readLine(proc.stdout)));
    const envelope = JSON.parse(raw);

    assert.equal(envelope.success, true);
    assert.ok(envelope.result);
    assert.ok(typeof envelope.result.error === 'string');
    assert.ok(Array.isArray(envelope.result.did_you_mean_actions));
    assert.ok(envelope.result.did_you_mean_actions.includes('exec_follow'));
  } finally {
    await terminate(proc);
  }
});

test('schema errors include did-you-mean for unknown fields', async () => {
  const proc = startServer();
  try {
    proc.stdin.write(JSON.stringify(MCP_INIT) + '\n');
    JSON.parse(await readLine(proc.stdout));

    proc.stdin.write(JSON.stringify(callTool(2, 'ssh', {
      action: 'exec',
      target: 'prod',
      commnd: 'uname -a',
    })) + '\n');

    const resp = JSON.parse(await readLine(proc.stdout));
    assert.equal(resp.jsonrpc, '2.0');
    assert.ok(resp.error);
    assert.equal(typeof resp.error.message, 'string');
    assert.ok(resp.error.message.includes("unknown field 'commnd'"));
    assert.ok(resp.error.message.includes('Did you mean'));
    assert.ok(resp.error.message.includes('command'));
    assert.ok(resp.error.message.includes("help({ tool: 'ssh', action: 'exec' })"));
  } finally {
    await terminate(proc);
  }
});

