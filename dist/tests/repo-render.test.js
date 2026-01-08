"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// @ts-nocheck
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const RepoManager = require('../src/managers/RepoManager');
const { resolveArtifactPath } = require('../src/utils/artifacts');
const loggerStub = {
    child() {
        return this;
    },
    info() { },
    warn() { },
    error() { },
};
const securityStub = {
    cleanCommand(value) {
        if (typeof value !== 'string') {
            throw new Error('Command must be a string');
        }
        const trimmed = value.trim();
        if (!trimmed) {
            throw new Error('Command must not be empty');
        }
        if (trimmed.includes('\0')) {
            throw new Error('Command contains null bytes');
        }
        return trimmed;
    },
    ensureSizeFits(payload, options = {}) {
        const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : 1024 * 1024;
        const text = typeof payload === 'string' ? payload : String(payload ?? '');
        const bytes = Buffer.byteLength(text, 'utf8');
        if (bytes > maxBytes) {
            throw new Error('Payload exceeds size limit');
        }
        return { ok: true, bytes, maxBytes };
    },
};
const validationStub = {
    ensureString(value, label, { trim = true } = {}) {
        if (typeof value !== 'string') {
            throw new Error(`${label} must be a non-empty string`);
        }
        const normalized = value.trim();
        if (!normalized) {
            throw new Error(`${label} must be a non-empty string`);
        }
        return trim ? normalized : value;
    },
};
async function makeTempDir(prefix) {
    return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}
test('repo.render (plain) writes render.yaml artifact for a file overlay', async (t) => {
    const repoRoot = await makeTempDir('sf-repo-render-');
    const contextRoot = await makeTempDir('sf-context-root-');
    const prevContext = process.env.SF_CONTEXT_REPO_ROOT;
    process.env.SF_CONTEXT_REPO_ROOT = contextRoot;
    t.after(async () => {
        process.env.SF_CONTEXT_REPO_ROOT = prevContext;
        await fs.rm(repoRoot, { recursive: true, force: true });
        await fs.rm(contextRoot, { recursive: true, force: true });
    });
    execFileSync('git', ['init'], { cwd: repoRoot, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot, stdio: 'ignore' });
    const manifest = 'apiVersion: v1\nkind: Namespace\nmetadata:\n  name: demo\n';
    await fs.writeFile(path.join(repoRoot, 'manifest.yaml'), manifest, 'utf8');
    execFileSync('git', ['add', '-A'], { cwd: repoRoot, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoRoot, stdio: 'ignore' });
    const manager = new RepoManager(loggerStub, securityStub, validationStub, null);
    const result = await manager.handleAction({
        action: 'render',
        repo_root: repoRoot,
        render_type: 'plain',
        overlay: 'manifest.yaml',
        trace_id: 'trace-render',
        span_id: 'span-render',
    });
    assert.equal(result.success, true);
    assert.equal(result.render_type, 'plain');
    assert.ok(result.render_ref);
    assert.ok(result.render_ref.rel.endsWith('/render.yaml'));
    const artifactPath = resolveArtifactPath(contextRoot, result.render_ref.rel);
    const rendered = await fs.readFile(artifactPath, 'utf8');
    assert.equal(rendered, manifest);
});
test('repo.render extracts container images and writes images.json artifact', async (t) => {
    const repoRoot = await makeTempDir('sf-repo-render-');
    const contextRoot = await makeTempDir('sf-context-root-');
    const prevContext = process.env.SF_CONTEXT_REPO_ROOT;
    process.env.SF_CONTEXT_REPO_ROOT = contextRoot;
    t.after(async () => {
        process.env.SF_CONTEXT_REPO_ROOT = prevContext;
        await fs.rm(repoRoot, { recursive: true, force: true });
        await fs.rm(contextRoot, { recursive: true, force: true });
    });
    execFileSync('git', ['init'], { cwd: repoRoot, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot, stdio: 'ignore' });
    const manifest = `apiVersion: v1
kind: Pod
metadata:
  name: demo
spec:
  containers:
    - name: app
      image: nginx:1.27.1
`;
    await fs.writeFile(path.join(repoRoot, 'manifest.yaml'), manifest, 'utf8');
    execFileSync('git', ['add', '-A'], { cwd: repoRoot, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoRoot, stdio: 'ignore' });
    const manager = new RepoManager(loggerStub, securityStub, validationStub, null);
    const result = await manager.handleAction({
        action: 'render',
        repo_root: repoRoot,
        render_type: 'plain',
        overlay: 'manifest.yaml',
        trace_id: 'trace-render',
        span_id: 'span-render',
    });
    assert.equal(result.success, true);
    assert.equal(result.images_summary.total, 1);
    assert.equal(result.images_summary.unpinned, 1);
    assert.equal(result.images_summary.latest, 0);
    assert.equal(result.images[0].image, 'nginx:1.27.1');
    assert.equal(result.images[0].resource_kind, 'Pod');
    assert.equal(result.images[0].resource_name, 'demo');
    assert.ok(result.images_ref);
    assert.ok(result.images_ref.rel.endsWith('/images.json'));
    const imagesPath = resolveArtifactPath(contextRoot, result.images_ref.rel);
    const payload = JSON.parse(await fs.readFile(imagesPath, 'utf8'));
    assert.equal(payload.summary.total, 1);
    assert.equal(payload.images[0].image, 'nginx:1.27.1');
});
