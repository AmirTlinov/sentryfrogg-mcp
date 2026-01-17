// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { startServer, readLine, terminate } from './util';

const MCP_INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'dx-mode-exec-test', version: '1.0.0' },
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

test('repo.exec in ai-mode returns compact exec envelope (stdout without inline=true)', async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-dx-repo-exec-'));
  try {
    execFileSync('git', ['init'], { cwd: repoRoot, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot, stdio: 'ignore' });
    await fs.writeFile(path.join(repoRoot, 'note.txt'), 'hello\n', 'utf8');
    execFileSync('git', ['add', 'note.txt'], { cwd: repoRoot, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoRoot, stdio: 'ignore' });

    const proc = startServer();
    try {
      proc.stdin.write(JSON.stringify(MCP_INIT) + '\n');
      JSON.parse(await readLine(proc.stdout));

      const traceId = 'trace-repo-exec-dx';
      const spanId = 'span-repo-exec-dx';
      proc.stdin.write(JSON.stringify(callTool(2, 'mcp_repo', {
        action: 'exec',
        repo_root: repoRoot,
        command: 'git',
        args: ['rev-parse', '--is-inside-work-tree'],
        trace_id: traceId,
        span_id: spanId,
        response_mode: 'ai',
      })) + '\n');

      const raw = parseToolText(JSON.parse(await readLine(proc.stdout)));
      const envelope = JSON.parse(raw);

      assert.equal(envelope.tool, 'repo');
      assert.equal(envelope.action, 'exec');
      assert.equal(envelope.mode, 'sync');
      assert.equal(envelope.exit_code, 0);
      assert.equal(envelope.timed_out, false);
      assert.ok(typeof envelope.stdout === 'string');
      assert.ok(envelope.stdout.includes('true'));
      assert.equal(envelope.stdout_truncated, false);
      assert.ok(Array.isArray(envelope.next_actions));

      assert.equal(envelope.trace.trace_id, traceId);
      assert.equal(envelope.trace.span_id, spanId);
      assert.ok(envelope.artifact_uri_json);
      assert.ok(envelope.artifact_uri_json.endsWith('/result.json'));
    } finally {
      await terminate(proc);
    }
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test('local.exec in ai-mode returns compact exec envelope (stdout without inline=true)', async () => {
  const proc = startServer([], { SENTRYFROGG_UNSAFE_LOCAL: '1' });
  try {
    proc.stdin.write(JSON.stringify(MCP_INIT) + '\n');
    JSON.parse(await readLine(proc.stdout));

    const traceId = 'trace-local-exec-dx';
    const spanId = 'span-local-exec-dx';
    proc.stdin.write(JSON.stringify(callTool(2, 'mcp_local', {
      action: 'exec',
      command: process.execPath,
      args: ['-e', 'process.stdout.write("hello")'],
      trace_id: traceId,
      span_id: spanId,
      response_mode: 'ai',
    })) + '\n');

    const raw = parseToolText(JSON.parse(await readLine(proc.stdout)));
    const envelope = JSON.parse(raw);

    assert.equal(envelope.tool, 'local');
    assert.equal(envelope.action, 'exec');
    assert.equal(envelope.mode, 'sync');
    assert.equal(envelope.exit_code, 0);
    assert.equal(envelope.timed_out, false);
    assert.equal(envelope.stdout, 'hello');
    assert.equal(envelope.stdout_truncated, false);
    assert.ok(Array.isArray(envelope.next_actions));

    assert.equal(envelope.trace.trace_id, traceId);
    assert.equal(envelope.trace.span_id, spanId);
    assert.ok(envelope.artifact_uri_json);
    assert.ok(envelope.artifact_uri_json.endsWith('/result.json'));
  } finally {
    await terminate(proc);
  }
});

