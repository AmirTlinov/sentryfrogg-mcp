// @ts-nocheck
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { startServer, readLine, terminate } = require('./util');
const { resolveArtifactPath } = require('../src/utils/artifacts');

const MCP_INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'gitops-test', version: '1.0.0' },
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

test('workspace.run executes gitops.plan without apply and returns render artifact refs', async () => {
  const proc = startServer();
  const contextRoot = proc.__sentryfrogg_profiles_dir;
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-gitops-plan-'));

  await fs.mkdir(path.join(repoRoot, '.argocd'), { recursive: true });
  await fs.writeFile(
    path.join(repoRoot, 'manifest.yaml'),
    'apiVersion: v1\nkind: Namespace\nmetadata:\n  name: demo\n',
    'utf8'
  );

  execFileSync('git', ['init'], { cwd: repoRoot, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot, stdio: 'ignore' });
  execFileSync('git', ['add', '-A'], { cwd: repoRoot, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoRoot, stdio: 'ignore' });

  try {
    proc.stdin.write(`${JSON.stringify(MCP_INIT)}\n`);
    JSON.parse(await readLine(proc.stdout));

    proc.stdin.write(
      `${JSON.stringify(
        callTool(2, 'mcp_workspace', {
          action: 'run',
          intent_type: 'gitops.plan',
          repo_root: repoRoot,
          inputs: {
            overlay: 'manifest.yaml',
            render_type: 'plain',
          },
        })
      )}\n`
    );

    const envelope = JSON.parse(parseToolText(JSON.parse(await readLine(proc.stdout))));
    assert.ok(envelope.artifact_uri_context, 'expected artifact_uri_context on envelope');
    const contextRel = envelope.artifact_uri_context.replace(/^artifact:\/\//, '');
    const contextPath = resolveArtifactPath(contextRoot, contextRel);
    const contextText = await fs.readFile(contextPath, 'utf8');

    const renderLine = contextText
      .split('\n')
      .find((line) => line.startsWith('R: artifact://') && line.includes('/render.yaml'));

    assert.ok(renderLine, `expected render.yaml reference in output, got:\n${contextText}`);

    const uri = renderLine.slice(3).trim();
    const rel = uri.replace(/^artifact:\/\//, '');
    const artifactPath = resolveArtifactPath(contextRoot, rel);
    const rendered = await fs.readFile(artifactPath, 'utf8');
    assert.ok(rendered.includes('kind: Namespace'));
  } finally {
    await terminate(proc);
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});
