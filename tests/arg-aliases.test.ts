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
    clientInfo: { name: 'arg-aliases-test', version: '1.0.0' },
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

test('arg aliases: cmd/argv/timeout are normalized for repo.exec (and reported)', async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-alias-repo-'));
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

      proc.stdin.write(JSON.stringify(callTool(2, 'mcp_repo', {
        action: 'exec',
        repo_root: repoRoot,
        cmd: 'git',
        argv: ['rev-parse', '--is-inside-work-tree'],
        timeout: 10000,
        response_mode: 'ai',
      })) + '\n');

      const raw = parseToolText(JSON.parse(await readLine(proc.stdout)));
      const envelope = JSON.parse(raw);

      assert.equal(envelope.tool, 'repo');
      assert.equal(envelope.action, 'exec');
      assert.equal(envelope.exit_code, 0);
      assert.ok(String(envelope.stdout).includes('true'));
      assert.ok(envelope.normalization);
      assert.ok(Array.isArray(envelope.normalization.renamed));
      assert.ok(envelope.normalization.renamed.some((e) => e.from === 'cmd' && e.to === 'command'));
      assert.ok(envelope.normalization.renamed.some((e) => e.from === 'argv' && e.to === 'args'));
      assert.ok(envelope.normalization.renamed.some((e) => e.from === 'timeout' && e.to === 'timeout_ms'));
    } finally {
      await terminate(proc);
    }
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test('arg aliases: alias is ignored when canonical key is present (no silent overwrite)', async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-alias-repo-2-'));
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

      proc.stdin.write(JSON.stringify(callTool(2, 'mcp_repo', {
        action: 'exec',
        repo_root: repoRoot,
        command: 'git',
        cmd: 'echo',
        args: ['rev-parse', '--is-inside-work-tree'],
        response_mode: 'ai',
      })) + '\n');

      const raw = parseToolText(JSON.parse(await readLine(proc.stdout)));
      const envelope = JSON.parse(raw);

      assert.equal(envelope.tool, 'repo');
      assert.equal(envelope.action, 'exec');
      assert.equal(envelope.exit_code, 0);
      assert.ok(envelope.normalization);
      assert.ok(Array.isArray(envelope.normalization.ignored));
      assert.ok(envelope.normalization.ignored.some((e) => e.from === 'cmd' && e.to === 'command' && e.reason === 'canonical_already_set'));
    } finally {
      await terminate(proc);
    }
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test('help supports q -> query alias', async () => {
  const proc = startServer();
  try {
    proc.stdin.write(JSON.stringify(MCP_INIT) + '\n');
    JSON.parse(await readLine(proc.stdout));

    proc.stdin.write(JSON.stringify(callTool(2, 'help', { q: 'exec_follow', limit: 25 })) + '\n');
    const raw = parseToolText(JSON.parse(await readLine(proc.stdout)));
    const envelope = JSON.parse(raw);

    assert.equal(envelope.success, true);
    assert.ok(envelope.result);
    assert.equal(envelope.result.query, 'exec_follow');
    assert.ok(Array.isArray(envelope.result.results));
    assert.ok(envelope.normalization);
    assert.ok(envelope.normalization.renamed.some((e) => e.from === 'q' && e.to === 'query'));
  } finally {
    await terminate(proc);
  }
});

