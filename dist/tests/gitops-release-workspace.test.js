"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// @ts-nocheck
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
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
    const envelope = JSON.parse(text);
    const traceId = envelope?.trace?.trace_id;
    assert.ok(traceId, `expected trace.trace_id in output, got:\n${text}`);
    return traceId;
}
async function writeKubectlStub(dir) {
    const scriptPath = path.join(dir, 'kubectl');
    const body = `#!/usr/bin/env node
const fs = require('node:fs');

const statePath = process.env.KUBECTL_STUB_STATE;
const mode = process.env.KUBECTL_STUB_MODE || 'happy';
const argv = process.argv.slice(2);

let state = { argocd_gets: 0, argocd_patches: 0 };
if (statePath && fs.existsSync(statePath)) {
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch (error) {
  }
}

const has = (token) => argv.includes(token);

if (has('patch') && has('application')) {
  state.argocd_patches += 1;
  if (statePath) {
    fs.writeFileSync(statePath, JSON.stringify(state));
  }
  process.exit(0);
}

if (has('get') && has('application')) {
  state.argocd_gets += 1;

  let out = 'Synced Healthy';
  if (mode === 'rollback') {
    if (state.argocd_patches >= 2) {
      out = 'Synced Healthy';
    } else if (state.argocd_patches === 1 && state.argocd_gets === 1) {
      out = 'Synced Healthy';
    } else {
      out = 'OutOfSync Progressing';
    }
  }

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
function startFakeGithubServer({ remoteBare }) {
    const requests = [];
    let statusCalls = 0;
    let lastPr = null;
    const server = http.createServer(async (req, res) => {
        if (req.method === 'POST' && req.url === '/repos/acme/demo/pulls') {
            const chunks = [];
            for await (const chunk of req) {
                chunks.push(chunk);
            }
            const raw = Buffer.concat(chunks).toString('utf8');
            const body = raw ? JSON.parse(raw) : null;
            requests.push({ method: req.method, url: req.url, body });
            lastPr = body;
            res.writeHead(201, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ number: 1, html_url: 'https://github.com/acme/demo/pull/1' }));
            return;
        }
        if (req.method === 'GET' && /^\/repos\/acme\/demo\/commits\/[^/]+\/status$/.test(req.url)) {
            requests.push({ method: req.method, url: req.url, body: null });
            statusCalls += 1;
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ state: statusCalls >= 2 ? 'success' : 'pending' }));
            return;
        }
        if (req.method === 'PUT' && req.url === '/repos/acme/demo/pulls/1/merge') {
            const chunks = [];
            for await (const chunk of req) {
                chunks.push(chunk);
            }
            const raw = Buffer.concat(chunks).toString('utf8');
            const body = raw ? JSON.parse(raw) : null;
            requests.push({ method: req.method, url: req.url, body });
            if (lastPr && remoteBare) {
                const head = String(lastPr.head || '').split(':')[1];
                const base = String(lastPr.base || '').trim();
                if (head && base) {
                    const sha = execFileSync('git', ['--git-dir', remoteBare, 'rev-parse', `refs/heads/${head}`])
                        .toString('utf8')
                        .trim();
                    execFileSync('git', ['--git-dir', remoteBare, 'update-ref', `refs/heads/${base}`, sha], { stdio: 'ignore' });
                }
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ merged: true }));
            return;
        }
        if (req.method === 'POST' && req.url === '/repos/acme/demo/issues/1/comments') {
            const chunks = [];
            for await (const chunk of req) {
                chunks.push(chunk);
            }
            const raw = Buffer.concat(chunks).toString('utf8');
            const body = raw ? JSON.parse(raw) : null;
            requests.push({ method: req.method, url: req.url, body });
            res.writeHead(201, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ id: 10 }));
            return;
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            resolve({
                server,
                baseUrl: `http://127.0.0.1:${address.port}`,
                requests,
            });
        });
    });
}
function gitShowFile(gitDir, ref, filePath) {
    return execFileSync('git', ['--git-dir', gitDir, 'show', `${ref}:${filePath}`]).toString('utf8');
}
test('workspace.run gitops.release (argocd) performs full loop and marks verified', async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-gitops-release-'));
    const remoteRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-gitops-release-remote-'));
    const remoteBare = path.join(remoteRoot, 'remote.git');
    const stubDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-kubectl-stub-'));
    const statePath = path.join(stubDir, 'state.json');
    execFileSync('git', ['init', '--bare', remoteBare], { stdio: 'ignore' });
    await fs.mkdir(path.join(repoRoot, '.argocd'), { recursive: true });
    await fs.writeFile(path.join(repoRoot, 'manifest.yaml'), 'apiVersion: v1\nkind: Namespace\nmetadata:\n  name: demo\n', 'utf8');
    execFileSync('git', ['init'], { cwd: repoRoot, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot, stdio: 'ignore' });
    execFileSync('git', ['add', '-A'], { cwd: repoRoot, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoRoot, stdio: 'ignore' });
    const baseBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot })
        .toString('utf8')
        .trim();
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/demo.git'], { cwd: repoRoot, stdio: 'ignore' });
    execFileSync('git', ['remote', 'add', 'local', remoteBare], { cwd: repoRoot, stdio: 'ignore' });
    execFileSync('git', ['push', 'local', baseBranch], { cwd: repoRoot, stdio: 'ignore' });
    await fs.writeFile(path.join(repoRoot, 'manifest.yaml'), 'apiVersion: v1\nkind: Namespace\nmetadata:\n  name: demo2\n', 'utf8');
    const patch = execFileSync('git', ['diff'], { cwd: repoRoot }).toString('utf8');
    execFileSync('git', ['checkout', '--', 'manifest.yaml'], { cwd: repoRoot, stdio: 'ignore' });
    assert.ok(patch.includes('demo2'));
    await writeKubectlStub(stubDir);
    const fake = await startFakeGithubServer({ remoteBare });
    const proc = startServer([], {
        SF_REPO_ALLOWED_COMMANDS: 'git,kubectl',
        PATH: `${stubDir}:${process.env.PATH}`,
        KUBECTL_STUB_STATE: statePath,
        KUBECTL_STUB_MODE: 'happy',
    });
    try {
        proc.stdin.write(`${JSON.stringify(MCP_INIT)}\n`);
        JSON.parse(await readLine(proc.stdout));
        proc.stdin.write(`${JSON.stringify(callTool(2, 'mcp_workspace', {
            action: 'run',
            intent_type: 'gitops.release',
            apply: true,
            repo_root: repoRoot,
            inputs: {
                policy: { mode: 'operatorless' },
                overlay: 'manifest.yaml',
                render_type: 'plain',
                patch,
                message: 'gitops: update namespace',
                title: 'Update namespace',
                remote: 'local',
                base_branch: baseBranch,
                github_api_base_url: fake.baseUrl,
                wait_for_checks: true,
                checks_max_attempts: 2,
                checks_delay_ms: 0,
                merge: true,
                merge_method: 'squash',
                kubeconfig: '/tmp/kubeconfig',
                namespace: 'argocd',
                app_name: 'demo',
            },
        }))}\n`);
        const text = parseToolText(JSON.parse(await readLine(proc.stdout)));
        const traceId = parseTraceId(text);
        proc.stdin.write(`${JSON.stringify(callTool(3, 'mcp_state', {
            action: 'get',
            scope: 'session',
            key: `gitops.release.verified.${traceId}`,
            output: { path: 'value' },
        }))}\n`);
        const verified = JSON.parse(parseToolText(JSON.parse(await readLine(proc.stdout))));
        assert.equal(verified.tool, 'mcp_state');
        assert.equal(verified.action, 'get');
        assert.equal(verified.result, true);
        const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
        assert.equal(state.argocd_patches, 1);
        assert.equal(state.argocd_gets, 2);
        assert.equal(fake.requests.length, 5);
        assert.equal(fake.requests[0].body.title, 'Update namespace');
        assert.equal(fake.requests[0].body.base, baseBranch);
        assert.equal(fake.requests[1].url, '/repos/acme/demo/issues/1/comments');
        const merged = gitShowFile(remoteBare, `refs/heads/${baseBranch}`, 'manifest.yaml');
        assert.ok(merged.includes('demo2'));
    }
    finally {
        await new Promise((resolve) => fake.server.close(resolve));
        await terminate(proc);
        await fs.rm(repoRoot, { recursive: true, force: true });
        await fs.rm(remoteRoot, { recursive: true, force: true });
        await fs.rm(stubDir, { recursive: true, force: true });
    }
});
test('workspace.run gitops.release (argocd) rolls back on verify failure', async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-gitops-release-'));
    const remoteRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-gitops-release-remote-'));
    const remoteBare = path.join(remoteRoot, 'remote.git');
    const stubDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-kubectl-stub-'));
    const statePath = path.join(stubDir, 'state.json');
    execFileSync('git', ['init', '--bare', remoteBare], { stdio: 'ignore' });
    await fs.mkdir(path.join(repoRoot, '.argocd'), { recursive: true });
    await fs.writeFile(path.join(repoRoot, 'manifest.yaml'), 'apiVersion: v1\nkind: Namespace\nmetadata:\n  name: demo\n', 'utf8');
    execFileSync('git', ['init'], { cwd: repoRoot, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot, stdio: 'ignore' });
    execFileSync('git', ['add', '-A'], { cwd: repoRoot, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoRoot, stdio: 'ignore' });
    const baseBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot })
        .toString('utf8')
        .trim();
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/demo.git'], { cwd: repoRoot, stdio: 'ignore' });
    execFileSync('git', ['remote', 'add', 'local', remoteBare], { cwd: repoRoot, stdio: 'ignore' });
    execFileSync('git', ['push', 'local', baseBranch], { cwd: repoRoot, stdio: 'ignore' });
    await fs.writeFile(path.join(repoRoot, 'manifest.yaml'), 'apiVersion: v1\nkind: Namespace\nmetadata:\n  name: demo2\n', 'utf8');
    const patch = execFileSync('git', ['diff'], { cwd: repoRoot }).toString('utf8');
    execFileSync('git', ['checkout', '--', 'manifest.yaml'], { cwd: repoRoot, stdio: 'ignore' });
    assert.ok(patch.includes('demo2'));
    const initial = gitShowFile(remoteBare, `refs/heads/${baseBranch}`, 'manifest.yaml');
    assert.ok(initial.includes('demo'));
    await writeKubectlStub(stubDir);
    const fake = await startFakeGithubServer({ remoteBare });
    const proc = startServer([], {
        SF_REPO_ALLOWED_COMMANDS: 'git,kubectl',
        PATH: `${stubDir}:${process.env.PATH}`,
        KUBECTL_STUB_STATE: statePath,
        KUBECTL_STUB_MODE: 'rollback',
    });
    try {
        proc.stdin.write(`${JSON.stringify(MCP_INIT)}\n`);
        JSON.parse(await readLine(proc.stdout));
        proc.stdin.write(`${JSON.stringify(callTool(2, 'mcp_workspace', {
            action: 'run',
            intent_type: 'gitops.release',
            apply: true,
            repo_root: repoRoot,
            inputs: {
                policy: { mode: 'operatorless' },
                overlay: 'manifest.yaml',
                render_type: 'plain',
                patch,
                message: 'gitops: update namespace',
                title: 'Update namespace',
                remote: 'local',
                base_branch: baseBranch,
                github_api_base_url: fake.baseUrl,
                wait_for_checks: true,
                checks_max_attempts: 2,
                checks_delay_ms: 0,
                merge: true,
                merge_method: 'squash',
                kubeconfig: '/tmp/kubeconfig',
                namespace: 'argocd',
                app_name: 'demo',
                max_attempts: 2,
                delay_ms: 0,
            },
        }))}\n`);
        const text = parseToolText(JSON.parse(await readLine(proc.stdout)));
        const traceId = parseTraceId(text);
        const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
        assert.equal(state.argocd_patches, 2);
        assert.equal(fake.requests.length, 5);
        assert.equal(fake.requests[1].url, '/repos/acme/demo/issues/1/comments');
        const afterRollback = gitShowFile(remoteBare, `refs/heads/${baseBranch}`, 'manifest.yaml');
        assert.ok(afterRollback.includes('demo\n'));
        assert.ok(!afterRollback.includes('demo2'));
        proc.stdin.write(`${JSON.stringify(callTool(3, 'mcp_state', {
            action: 'get',
            scope: 'session',
            key: `gitops.release.verified.${traceId}`,
            output: { path: 'value' },
        }))}\n`);
        const missingResp = JSON.parse(await readLine(proc.stdout));
        assert.ok(missingResp.error);
    }
    finally {
        await new Promise((resolve) => fake.server.close(resolve));
        await terminate(proc);
        await fs.rm(repoRoot, { recursive: true, force: true });
        await fs.rm(remoteRoot, { recursive: true, force: true });
        await fs.rm(stubDir, { recursive: true, force: true });
    }
});
