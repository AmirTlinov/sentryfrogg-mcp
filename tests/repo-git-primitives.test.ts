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
  info() {},
  warn() {},
  error() {},
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

test('repo git primitives enforce apply gating for write actions', async (t) => {
  const repoRoot = await makeTempDir('sf-repo-git-');
  t.after(async () => fs.rm(repoRoot, { recursive: true, force: true }));

  execFileSync('git', ['init', '-b', 'main'], { cwd: repoRoot, stdio: 'ignore' });
  const manager = new RepoManager(loggerStub, securityStub, validationStub, null);

  await assert.rejects(
    () => manager.handleAction({ action: 'apply_patch', repo_root: repoRoot, patch: 'x' }),
    /apply=true is required/
  );

  await assert.rejects(
    () => manager.handleAction({ action: 'git_commit', repo_root: repoRoot, message: 'x' }),
    /apply=true is required/
  );

  await assert.rejects(
    () => manager.handleAction({ action: 'git_push', repo_root: repoRoot }),
    /apply=true is required/
  );
});

test('repo can apply patch, commit, and push to a local bare remote', async (t) => {
  const repoRoot = await makeTempDir('sf-repo-git-');
  const remoteRoot = await makeTempDir('sf-repo-remote-');
  const contextRoot = await makeTempDir('sf-context-root-');

  const prevContext = process.env.SF_CONTEXT_REPO_ROOT;
  process.env.SF_CONTEXT_REPO_ROOT = contextRoot;

  t.after(async () => {
    process.env.SF_CONTEXT_REPO_ROOT = prevContext;
    await fs.rm(repoRoot, { recursive: true, force: true });
    await fs.rm(remoteRoot, { recursive: true, force: true });
    await fs.rm(contextRoot, { recursive: true, force: true });
  });

  execFileSync('git', ['init', '-b', 'main'], { cwd: repoRoot, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot, stdio: 'ignore' });

  const filePath = path.join(repoRoot, 'hello.txt');
  await fs.writeFile(filePath, 'hello\n', 'utf8');
  execFileSync('git', ['add', 'hello.txt'], { cwd: repoRoot, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoRoot, stdio: 'ignore' });

  execFileSync('git', ['init', '--bare'], { cwd: remoteRoot, stdio: 'ignore' });
  execFileSync('git', ['remote', 'add', 'origin', remoteRoot], { cwd: repoRoot, stdio: 'ignore' });

  await fs.writeFile(filePath, 'hello world\n', 'utf8');
  const patch = execFileSync('git', ['diff'], { cwd: repoRoot, encoding: 'utf8' });
  execFileSync('git', ['checkout', '--', 'hello.txt'], { cwd: repoRoot, stdio: 'ignore' });

  const manager = new RepoManager(loggerStub, securityStub, validationStub, null);

  const applied = await manager.handleAction({
    action: 'apply_patch',
    repo_root: repoRoot,
    patch,
    apply: true,
    trace_id: 'trace-git',
    span_id: 'span-git',
  });
  assert.equal(applied.success, true);
  assert.ok(applied.patch_ref);

  const diff = await manager.handleAction({
    action: 'git_diff',
    repo_root: repoRoot,
    trace_id: 'trace-git',
    span_id: 'span-diff',
  });
  assert.equal(diff.success, true);
  assert.ok(diff.diff_ref);

  const diffPath = resolveArtifactPath(contextRoot, diff.diff_ref.rel);
  const stat = await fs.stat(diffPath);
  assert.ok(stat.size >= 0);

  const committed = await manager.handleAction({
    action: 'git_commit',
    repo_root: repoRoot,
    message: 'test: update hello',
    apply: true,
  });
  assert.equal(committed.success, true);
  assert.ok(committed.sha);

  const pushed = await manager.handleAction({
    action: 'git_push',
    repo_root: repoRoot,
    remote: 'origin',
    branch: 'main',
    apply: true,
    trace_id: 'trace-git',
    span_id: 'span-git',
  });
  assert.equal(pushed.success, true);

  const remoteFile = execFileSync('git', ['--git-dir', remoteRoot, 'show', 'main:hello.txt'], { encoding: 'utf8' });
  assert.equal(remoteFile, 'hello world\n');
});

test('repo can revert a commit (git_revert)', async (t) => {
  const repoRoot = await makeTempDir('sf-repo-revert-');
  const contextRoot = await makeTempDir('sf-context-root-');

  const prevContext = process.env.SF_CONTEXT_REPO_ROOT;
  process.env.SF_CONTEXT_REPO_ROOT = contextRoot;

  t.after(async () => {
    process.env.SF_CONTEXT_REPO_ROOT = prevContext;
    await fs.rm(repoRoot, { recursive: true, force: true });
    await fs.rm(contextRoot, { recursive: true, force: true });
  });

  execFileSync('git', ['init', '-b', 'main'], { cwd: repoRoot, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot, stdio: 'ignore' });

  const filePath = path.join(repoRoot, 'hello.txt');
  await fs.writeFile(filePath, 'hello\n', 'utf8');
  execFileSync('git', ['add', 'hello.txt'], { cwd: repoRoot, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoRoot, stdio: 'ignore' });

  await fs.writeFile(filePath, 'hello world\n', 'utf8');
  execFileSync('git', ['add', 'hello.txt'], { cwd: repoRoot, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'change'], { cwd: repoRoot, stdio: 'ignore' });
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();

  const manager = new RepoManager(loggerStub, securityStub, validationStub, null);
  const reverted = await manager.handleAction({
    action: 'git_revert',
    repo_root: repoRoot,
    sha,
    apply: true,
    trace_id: 'trace-revert',
    span_id: 'span-revert',
  });

  assert.equal(reverted.success, true);
  assert.equal(reverted.reverted_sha, sha);
  assert.ok(reverted.head);
  assert.ok(reverted.revert_ref);

  const content = await fs.readFile(filePath, 'utf8');
  assert.equal(content, 'hello\n');

  const logPath = resolveArtifactPath(contextRoot, reverted.revert_ref.rel);
  const stat = await fs.stat(logPath);
  assert.ok(stat.size >= 0);
});

test('apply_patch rejects traversal paths inside patch headers', async (t) => {
  const repoRoot = await makeTempDir('sf-repo-git-');
  t.after(async () => fs.rm(repoRoot, { recursive: true, force: true }));

  execFileSync('git', ['init', '-b', 'main'], { cwd: repoRoot, stdio: 'ignore' });

  const manager = new RepoManager(loggerStub, securityStub, validationStub, null);
  const patch = [
    'diff --git a/../evil.txt b/../evil.txt',
    'new file mode 100644',
    'index 0000000..1111111',
    '--- /dev/null',
    '+++ b/../evil.txt',
    '@@ -0,0 +1 @@',
    '+nope',
    '',
  ].join('\n');

  await assert.rejects(
    () => manager.handleAction({ action: 'apply_patch', repo_root: repoRoot, patch, apply: true }),
    /escapes repo_root/
  );
});
