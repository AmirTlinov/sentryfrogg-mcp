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
function parseTraceId(text) {
    const envelope = JSON.parse(text);
    const traceId = envelope?.trace?.trace_id;
    assert.ok(traceId, `expected trace.trace_id in output, got:\n${text}`);
    return traceId;
}
function startFakeGithubServer() {
    const requests = [];
    let statusCalls = 0;
    const server = http.createServer(async (req, res) => {
        if (req.method === 'POST' && req.url === '/repos/acme/demo/pulls') {
            const chunks = [];
            for await (const chunk of req) {
                chunks.push(chunk);
            }
            const raw = Buffer.concat(chunks).toString('utf8');
            const body = raw ? JSON.parse(raw) : null;
            requests.push({ method: req.method, url: req.url, body });
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
test('workspace.run executes gitops.propose with apply and creates a PR (GitHub API)', async () => {
    const proc = startServer();
    const contextRoot = proc.__sentryfrogg_profiles_dir;
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-gitops-propose-'));
    const remoteRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-gitops-propose-remote-'));
    const remoteBare = path.join(remoteRoot, 'remote.git');
    execFileSync('git', ['init', '--bare', remoteBare], { stdio: 'ignore' });
    await fs.mkdir(path.join(repoRoot, '.argocd'), { recursive: true });
    await fs.writeFile(path.join(repoRoot, 'manifest.yaml'), 'apiVersion: v1\nkind: Namespace\nmetadata:\n  name: demo\n', 'utf8');
    execFileSync('git', ['init'], { cwd: repoRoot, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot, stdio: 'ignore' });
    execFileSync('git', ['add', '-A'], { cwd: repoRoot, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoRoot, stdio: 'ignore' });
    const baseBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot }).toString('utf8').trim();
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/demo.git'], { cwd: repoRoot, stdio: 'ignore' });
    execFileSync('git', ['remote', 'set-url', '--push', 'origin', remoteBare], { cwd: repoRoot, stdio: 'ignore' });
    execFileSync('git', ['push', 'origin', baseBranch], { cwd: repoRoot, stdio: 'ignore' });
    await fs.writeFile(path.join(repoRoot, 'manifest.yaml'), 'apiVersion: v1\nkind: Namespace\nmetadata:\n  name: demo2\n', 'utf8');
    const patch = execFileSync('git', ['diff'], { cwd: repoRoot }).toString('utf8');
    assert.ok(patch.includes('demo2'));
    const fake = await startFakeGithubServer();
    try {
        proc.stdin.write(`${JSON.stringify(MCP_INIT)}\n`);
        JSON.parse(await readLine(proc.stdout));
        proc.stdin.write(`${JSON.stringify(callTool(2, 'mcp_workspace', {
            action: 'run',
            intent_type: 'gitops.plan',
            repo_root: repoRoot,
            inputs: {
                overlay: 'manifest.yaml',
                render_type: 'plain',
            },
        }))}\n`);
        const planText = parseToolText(JSON.parse(await readLine(proc.stdout)));
        const planTraceId = parseTraceId(planText);
        execFileSync('git', ['checkout', '--', 'manifest.yaml'], { cwd: repoRoot, stdio: 'ignore' });
        proc.stdin.write(`${JSON.stringify(callTool(3, 'mcp_workspace', {
            action: 'run',
            intent_type: 'gitops.propose',
            apply: true,
            repo_root: repoRoot,
            inputs: {
                policy: { mode: 'operatorless' },
                plan_trace_id: planTraceId,
                patch,
                message: 'gitops: update namespace',
                title: 'Update namespace',
                github_api_base_url: fake.baseUrl,
                wait_for_checks: true,
                checks_max_attempts: 2,
                checks_delay_ms: 0,
                merge: true,
                merge_method: 'squash',
            },
        }))}\n`);
        const text = parseToolText(JSON.parse(await readLine(proc.stdout)));
        const traceId = parseTraceId(text);
        const branchName = `sf/gitops/${traceId}`;
        const remoteSha = execFileSync('git', ['--git-dir', remoteBare, 'rev-parse', `refs/heads/${branchName}`]).toString('utf8').trim();
        assert.ok(remoteSha);
        assert.equal(fake.requests.length, 5, `expected 5 github requests, got: ${JSON.stringify(fake.requests)}`);
        const pr = fake.requests[0].body;
        assert.equal(pr.title, 'Update namespace');
        assert.equal(pr.base, baseBranch);
        assert.equal(pr.head, `acme:${branchName}`);
        assert.equal(fake.requests[1].url, '/repos/acme/demo/issues/1/comments');
        assert.ok(String(fake.requests[1].body?.body || '').includes('plan evidence'));
        assert.equal(fake.requests.filter((r) => r.method === 'GET').length, 2, `expected 2 github status polls, got: ${JSON.stringify(fake.requests)}`);
        const mergeReq = fake.requests.find((r) => r.method === 'PUT');
        assert.ok(mergeReq);
        assert.equal(mergeReq.body.merge_method, 'squash');
        const envelope = JSON.parse(text);
        assert.ok(envelope.artifact_uri_context, 'expected artifact_uri_context on envelope');
        const contextRel = envelope.artifact_uri_context.replace(/^artifact:\/\//, '');
        const contextPath = resolveArtifactPath(contextRoot, contextRel);
        const contextText = await fs.readFile(contextPath, 'utf8');
        const pushLine = contextText
            .split('\n')
            .find((line) => line.startsWith('R: artifact://') && line.includes('/push.log'));
        assert.ok(pushLine, `expected push.log reference in output, got:\n${contextText}`);
        const uri = pushLine.slice(3).trim();
        const rel = uri.replace(/^artifact:\/\//, '');
        const artifactPath = resolveArtifactPath(contextRoot, rel);
        const pushLog = await fs.readFile(artifactPath, 'utf8');
        assert.ok(pushLog.length > 0);
    }
    finally {
        await new Promise((resolve) => fake.server.close(resolve));
        await terminate(proc);
        await fs.rm(repoRoot, { recursive: true, force: true });
        await fs.rm(remoteRoot, { recursive: true, force: true });
    }
});
