// @ts-nocheck
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { startServer, readLine, terminate } = require('./util');

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

function parseTraceId(text) {
  const traceLine = text.split('\n').find((line) => line.startsWith('N: trace_id:'));
  assert.ok(traceLine, `expected trace_id in output, got:\n${text}`);
  return traceLine.replace('N: trace_id:', '').trim();
}

async function writeKubectlStub(dir) {
  const scriptPath = path.join(dir, 'kubectl');
  const body = `#!/usr/bin/env node
const fs = require('node:fs');

const statePath = process.env.KUBECTL_STUB_STATE;
const argv = process.argv.slice(2);

let state = { argocd_gets: 0, flux_gets: 0 };
if (statePath && fs.existsSync(statePath)) {
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch (error) {
  }
}

const has = (token) => argv.includes(token);

if (has('get') && has('application')) {
  state.argocd_gets += 1;
  const out = state.argocd_gets >= 3 ? 'Synced Healthy' : 'OutOfSync Progressing';
  if (statePath) {
    fs.writeFileSync(statePath, JSON.stringify(state));
  }
  process.stdout.write(out);
  process.exit(0);
}

if (has('get') && has('kustomization')) {
  state.flux_gets += 1;
  const out = state.flux_gets >= 2 ? 'True' : 'False';
  if (statePath) {
    fs.writeFileSync(statePath, JSON.stringify(state));
  }
  process.stdout.write(out);
  process.exit(0);
}

if (statePath) {
  fs.writeFileSync(statePath, JSON.stringify(state));
}
process.exit(0);
`;

  await fs.writeFile(scriptPath, body, { mode: 0o755 });
  return scriptPath;
}

test('workspace.run gitops.sync (argocd) triggers kubectl and waits for Synced/Healthy', async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-gitops-sync-'));
  const stubDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-kubectl-stub-'));
  const statePath = path.join(stubDir, 'state.json');

  await fs.mkdir(path.join(repoRoot, '.argocd'), { recursive: true });
  await fs.writeFile(
    path.join(repoRoot, 'manifest.yaml'),
    'apiVersion: v1\nkind: Namespace\nmetadata:\n  name: demo\n',
    'utf8'
  );
  await fs.writeFile(path.join(repoRoot, '.gitignore'), 'node_modules\n', 'utf8');
  await fs.writeFile(path.join(repoRoot, 'README.md'), '# demo\n', 'utf8');
  await fs.writeFile(path.join(repoRoot, 'kustomization.yaml'), 'resources:\n- manifest.yaml\n', 'utf8');
  // minimal git repo for gitops.plan gate
  require('node:child_process').execFileSync('git', ['init'], { cwd: repoRoot, stdio: 'ignore' });
  require('node:child_process').execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot, stdio: 'ignore' });
  require('node:child_process').execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot, stdio: 'ignore' });
  require('node:child_process').execFileSync('git', ['add', '-A'], { cwd: repoRoot, stdio: 'ignore' });
  require('node:child_process').execFileSync('git', ['commit', '-m', 'init'], { cwd: repoRoot, stdio: 'ignore' });
  await writeKubectlStub(stubDir);

  const proc = startServer([], {
    SF_REPO_ALLOWED_COMMANDS: 'git,kubectl',
    PATH: `${stubDir}:${process.env.PATH}`,
    KUBECTL_STUB_STATE: statePath,
  });

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
    const planText = parseToolText(JSON.parse(await readLine(proc.stdout)));
    const planTraceId = parseTraceId(planText);

    proc.stdin.write(
      `${JSON.stringify(
        callTool(3, 'mcp_workspace', {
          action: 'run',
          intent_type: 'gitops.sync',
          apply: true,
          repo_root: repoRoot,
          inputs: {
            policy: { mode: 'operatorless' },
            app_name: 'demo',
            kubeconfig: '/tmp/kubeconfig',
            namespace: 'argocd',
            plan_trace_id: planTraceId,
            wait: true,
            max_attempts: 3,
            delay_ms: 0,
          },
        })
      )}\n`
    );

    parseToolText(JSON.parse(await readLine(proc.stdout)));
    const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    assert.equal(state.argocd_gets, 3);
  } finally {
    await terminate(proc);
    await fs.rm(repoRoot, { recursive: true, force: true });
    await fs.rm(stubDir, { recursive: true, force: true });
  }
});

test('workspace.run gitops.verify (flux) waits for Ready=True without apply', async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-gitops-verify-'));
  const stubDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-kubectl-stub-'));
  const statePath = path.join(stubDir, 'state.json');

  await fs.mkdir(path.join(repoRoot, 'flux-system'), { recursive: true });
  await fs.writeFile(
    path.join(repoRoot, 'manifest.yaml'),
    'apiVersion: v1\nkind: Namespace\nmetadata:\n  name: demo\n',
    'utf8'
  );
  require('node:child_process').execFileSync('git', ['init'], { cwd: repoRoot, stdio: 'ignore' });
  require('node:child_process').execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot, stdio: 'ignore' });
  require('node:child_process').execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot, stdio: 'ignore' });
  require('node:child_process').execFileSync('git', ['add', '-A'], { cwd: repoRoot, stdio: 'ignore' });
  require('node:child_process').execFileSync('git', ['commit', '-m', 'init'], { cwd: repoRoot, stdio: 'ignore' });
  await writeKubectlStub(stubDir);

  const proc = startServer([], {
    SF_REPO_ALLOWED_COMMANDS: 'git,kubectl',
    PATH: `${stubDir}:${process.env.PATH}`,
    KUBECTL_STUB_STATE: statePath,
  });

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
    parseToolText(JSON.parse(await readLine(proc.stdout)));

    proc.stdin.write(
      `${JSON.stringify(
        callTool(3, 'mcp_workspace', {
          action: 'run',
          intent_type: 'gitops.verify',
          repo_root: repoRoot,
          inputs: {
            kustomization_name: 'demo',
            kubeconfig: '/tmp/kubeconfig',
            namespace: 'flux-system',
            max_attempts: 2,
            delay_ms: 0,
          },
        })
      )}\n`
    );

    parseToolText(JSON.parse(await readLine(proc.stdout)));
    const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    assert.equal(state.flux_gets, 2);
  } finally {
    await terminate(proc);
    await fs.rm(repoRoot, { recursive: true, force: true });
    await fs.rm(stubDir, { recursive: true, force: true });
  }
});
