// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { startServer, readLine, terminate } from './util';

const MCP_INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'dx-mode-test', version: '1.0.0' },
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

test('response_mode=ai returns strict JSON and writes result.json artifact', async () => {
  const proc = startServer();
  try {
    proc.stdin.write(JSON.stringify(MCP_INIT) + '\n');
    JSON.parse(await readLine(proc.stdout));

    const traceId = 'trace-dx';
    const spanId = 'span-dx';

    proc.stdin.write(JSON.stringify(callTool(2, 'mcp_state', {
      action: 'set',
      key: 'dx_mode_test',
      value: { ok: true },
      scope: 'session',
      trace_id: traceId,
      span_id: spanId,
      response_mode: 'ai',
    })) + '\n');

    const raw = parseToolText(JSON.parse(await readLine(proc.stdout)));
    assert.ok(!raw.includes('[CONTENT]'));
    const envelope = JSON.parse(raw);
    assert.equal(envelope.tool, 'mcp_state');
    assert.equal(envelope.action, 'set');
    assert.ok(envelope.artifact_uri_json);
    assert.ok(envelope.artifact_uri_json.endsWith('/result.json'));
    assert.equal(envelope.trace.trace_id, traceId);
    assert.equal(envelope.trace.span_id, spanId);

    const root = proc.__sentryfrogg_profiles_dir;
    const artifactPath = path.join(root, 'artifacts', 'runs', traceId, 'tool_calls', spanId, 'result.json');
    const artifactText = await fs.readFile(artifactPath, 'utf8');
    const artifactJson = JSON.parse(artifactText);
    assert.equal(artifactJson.tool, 'mcp_state');
    assert.equal(artifactJson.action, 'set');
    assert.equal(artifactJson.artifact_uri_json, envelope.artifact_uri_json);

    proc.stdin.write(JSON.stringify(callTool(3, 'mcp_artifacts', {
      action: 'get',
      uri: envelope.artifact_uri_json,
      max_bytes: 1024 * 16,
      encoding: 'utf8',
      trace_id: 'trace-dx-2',
      span_id: 'span-dx-2',
      response_mode: 'ai',
    })) + '\n');
    const rawGet = parseToolText(JSON.parse(await readLine(proc.stdout)));
    const getEnvelope = JSON.parse(rawGet);
    assert.equal(getEnvelope.tool, 'artifacts');
    assert.equal(getEnvelope.action, 'get');
    assert.ok(getEnvelope.result);
    assert.ok(typeof getEnvelope.result.content === 'string');
    const parsedInner = JSON.parse(getEnvelope.result.content);
    assert.equal(parsedInner.tool, 'mcp_state');
    assert.equal(parsedInner.action, 'set');
  } finally {
    await terminate(proc);
  }
});

