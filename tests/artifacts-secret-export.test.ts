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
    clientInfo: { name: 'artifacts-secret-export-test', version: '1.0.0' },
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

async function createTextArtifactUri(proc) {
  proc.stdin.write(JSON.stringify(callTool(2, 'mcp_state', {
    action: 'set',
    key: 'artifact_text',
    value: { ok: true },
    scope: 'session',
    trace_id: 'trace-artifacts',
    span_id: 'span-artifacts',
    response_mode: 'ai',
  })) + '\n');

  const raw = parseToolText(JSON.parse(await readLine(proc.stdout)));
  const envelope = JSON.parse(raw);
  assert.equal(envelope.tool, 'mcp_state');
  assert.equal(envelope.action, 'set');
  assert.ok(envelope.artifact_uri_json);
  return envelope.artifact_uri_json;
}

test('mcp_artifacts blocks base64 reads for text artifacts by default', async () => {
  const proc = startServer();
  try {
    proc.stdin.write(JSON.stringify(MCP_INIT) + '\n');
    JSON.parse(await readLine(proc.stdout));

    const uri = await createTextArtifactUri(proc);

    proc.stdin.write(JSON.stringify(callTool(3, 'mcp_artifacts', {
      action: 'get',
      uri,
      encoding: 'base64',
      max_bytes: 1024 * 16,
    })) + '\n');

    const resp = JSON.parse(await readLine(proc.stdout));
    assert.equal(resp.jsonrpc, '2.0');
    assert.ok(resp.error);
    assert.equal(typeof resp.error.message, 'string');
    assert.ok(resp.error.message.includes('code: ARTIFACT_BASE64_BLOCKED'));
  } finally {
    await terminate(proc);
  }
});

test('mcp_artifacts include_secrets requires explicit allow flag', async () => {
  const proc = startServer();
  try {
    proc.stdin.write(JSON.stringify(MCP_INIT) + '\n');
    JSON.parse(await readLine(proc.stdout));

    const uri = await createTextArtifactUri(proc);

    proc.stdin.write(JSON.stringify(callTool(3, 'mcp_artifacts', {
      action: 'get',
      uri,
      encoding: 'base64',
      include_secrets: true,
      max_bytes: 1024 * 16,
    })) + '\n');

    const resp = JSON.parse(await readLine(proc.stdout));
    assert.equal(resp.jsonrpc, '2.0');
    assert.ok(resp.error);
    assert.equal(typeof resp.error.message, 'string');
    assert.ok(resp.error.message.includes('code: SECRET_EXPORT_DISABLED'));
  } finally {
    await terminate(proc);
  }
});

test('mcp_artifacts include_secrets allows base64 when allow flag is set', async () => {
  const proc = startServer([], { SF_ALLOW_SECRET_EXPORT: '1' });
  try {
    proc.stdin.write(JSON.stringify(MCP_INIT) + '\n');
    JSON.parse(await readLine(proc.stdout));

    const uri = await createTextArtifactUri(proc);

    proc.stdin.write(JSON.stringify(callTool(3, 'mcp_artifacts', {
      action: 'get',
      uri,
      encoding: 'base64',
      include_secrets: true,
      max_bytes: 1024 * 16,
      trace_id: 'trace-artifacts-2',
      span_id: 'span-artifacts-2',
      response_mode: 'ai',
    })) + '\n');

    const raw = parseToolText(JSON.parse(await readLine(proc.stdout)));
    const envelope = JSON.parse(raw);
    assert.equal(envelope.tool, 'artifacts');
    assert.equal(envelope.action, 'get');
    assert.ok(envelope.result);
    assert.ok(typeof envelope.result.content_base64 === 'string');
    assert.ok(envelope.result.content_base64.length > 0);
  } finally {
    await terminate(proc);
  }
});

