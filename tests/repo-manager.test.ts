// @ts-nocheck
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const RepoManager = require('../src/managers/RepoManager');

const loggerStub = {
  child() {
    return this;
  },
  info() {},
  warn() {},
  error() {},
};

const securityStub = {
  ensureSizeFits() {},
};

const validationStub = {
  ensureString(value) {
    return String(value);
  },
};

test('RepoManager rejects unknown actions', async () => {
  const manager = new RepoManager(loggerStub, securityStub, validationStub, null);
  await assert.rejects(() => manager.handleAction({ action: 'nope' }), /Unknown repo action/);
});

test('RepoManager assert_clean rejects dirty worktrees', async () => {
  const manager = new RepoManager(loggerStub, securityStub, validationStub, null);
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-repo-assert-clean-'));

  try {
    await fs.writeFile(path.join(repoRoot, 'README.md'), '# demo\n', 'utf8');

    execFileSync('git', ['init'], { cwd: repoRoot, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot, stdio: 'ignore' });
    execFileSync('git', ['add', '-A'], { cwd: repoRoot, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoRoot, stdio: 'ignore' });

    const clean = await manager.handleAction({ action: 'assert_clean', repo_root: repoRoot });
    assert.equal(clean.success, true);
    assert.equal(clean.clean, true);

    await fs.writeFile(path.join(repoRoot, 'README.md'), '# demo\n\nchanged\n', 'utf8');
    await assert.rejects(
      () => manager.handleAction({ action: 'assert_clean', repo_root: repoRoot }),
      /Repository is dirty/
    );

    execFileSync('git', ['checkout', '--', 'README.md'], { cwd: repoRoot, stdio: 'ignore' });
    await fs.writeFile(path.join(repoRoot, 'untracked.txt'), 'hi\n', 'utf8');

    await assert.rejects(
      () => manager.handleAction({ action: 'assert_clean', repo_root: repoRoot }),
      /Repository is dirty/
    );
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});
