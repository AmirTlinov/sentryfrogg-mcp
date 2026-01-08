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
test('repo.exec truncates large outputs, limits inline payloads, and spills to artifacts', async (t) => {
    const repoRoot = await makeTempDir('sf-repo-exec-');
    const contextRoot = await makeTempDir('sf-context-root-');
    const prevContext = process.env.SF_CONTEXT_REPO_ROOT;
    const prevCapture = process.env.SF_REPO_EXEC_MAX_CAPTURE_BYTES;
    const prevInline = process.env.SF_REPO_EXEC_MAX_INLINE_BYTES;
    process.env.SF_CONTEXT_REPO_ROOT = contextRoot;
    process.env.SF_REPO_EXEC_MAX_CAPTURE_BYTES = '1024';
    process.env.SF_REPO_EXEC_MAX_INLINE_BYTES = '128';
    t.after(async () => {
        process.env.SF_CONTEXT_REPO_ROOT = prevContext;
        process.env.SF_REPO_EXEC_MAX_CAPTURE_BYTES = prevCapture;
        process.env.SF_REPO_EXEC_MAX_INLINE_BYTES = prevInline;
        await fs.rm(repoRoot, { recursive: true, force: true });
        await fs.rm(contextRoot, { recursive: true, force: true });
    });
    execFileSync('git', ['init'], { cwd: repoRoot, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot, stdio: 'ignore' });
    const baseFile = path.join(repoRoot, 'big.txt');
    await fs.writeFile(baseFile, 'start\n', 'utf8');
    execFileSync('git', ['add', 'big.txt'], { cwd: repoRoot, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoRoot, stdio: 'ignore' });
    const line = 'x'.repeat(120);
    const big = Array.from({ length: 5000 }, () => `${line}\n`).join('');
    await fs.writeFile(baseFile, big, 'utf8');
    const manager = new RepoManager(loggerStub, securityStub, validationStub, null);
    const result = await manager.handleAction({
        action: 'exec',
        repo_root: repoRoot,
        command: 'git',
        args: ['diff'],
        trace_id: 'trace-budget',
        span_id: 'span-budget',
        inline: true,
    });
    assert.equal(result.command, 'git');
    assert.equal(result.exit_code, 0);
    assert.equal(result.stdout_captured_bytes, 1024);
    assert.equal(result.stdout_truncated, true);
    assert.equal(result.stdout_inline_truncated, true);
    assert.ok(result.stdout_ref);
    assert.equal(result.stdout_ref.bytes, 1024);
    assert.ok(Buffer.byteLength(result.stdout_inline, 'utf8') <= 128);
    const artifactPath = resolveArtifactPath(contextRoot, result.stdout_ref.rel);
    const stat = await fs.stat(artifactPath);
    assert.equal(stat.size, 1024);
});
