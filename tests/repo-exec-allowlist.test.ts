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

test('repo.exec rejects commands outside allowlist and disallows whitespace in command', async (t) => {
  const repoRoot = await makeTempDir('sf-repo-exec-');
  t.after(async () => fs.rm(repoRoot, { recursive: true, force: true }));

  const prevAllowlist = process.env.SENTRYFROGG_REPO_ALLOWED_COMMANDS;
  delete process.env.SENTRYFROGG_REPO_ALLOWED_COMMANDS;
  t.after(() => {
    if (prevAllowlist === undefined) {
      delete process.env.SENTRYFROGG_REPO_ALLOWED_COMMANDS;
    } else {
      process.env.SENTRYFROGG_REPO_ALLOWED_COMMANDS = prevAllowlist;
    }
  });

  const manager = new RepoManager(loggerStub, securityStub, validationStub, null);

  await assert.rejects(
    () => manager.handleAction({ action: 'exec', repo_root: repoRoot, command: 'bash', args: ['-c', 'echo hi'], apply: true }),
    /Command not allowed/
  );

  await assert.rejects(
    () => manager.handleAction({ action: 'exec', repo_root: repoRoot, command: 'git status', args: [], apply: true }),
    /single executable/
  );
});

test('repo.exec accepts wildcard allowlist for extra commands', async (t) => {
  const repoRoot = await makeTempDir('sf-repo-exec-');
  t.after(async () => fs.rm(repoRoot, { recursive: true, force: true }));

  const prevAllowlist = process.env.SENTRYFROGG_REPO_ALLOWED_COMMANDS;
  process.env.SENTRYFROGG_REPO_ALLOWED_COMMANDS = '*';

  t.after(() => {
    if (prevAllowlist === undefined) {
      delete process.env.SENTRYFROGG_REPO_ALLOWED_COMMANDS;
    } else {
      process.env.SENTRYFROGG_REPO_ALLOWED_COMMANDS = prevAllowlist;
    }
  });

  const manager = new RepoManager(loggerStub, securityStub, validationStub, null);
  const result = await manager.handleAction({
    action: 'exec',
    repo_root: repoRoot,
    command: 'echo',
    args: ['hello'],
    apply: true,
  });

  assert.equal(result.exit_code, 0);
});

test('repo.exec enforces sandboxed cwd and apply gating for mutating git subcommands', async (t) => {
  const repoRoot = await makeTempDir('sf-repo-exec-');
  const outside = await makeTempDir('sf-repo-exec-outside-');
  t.after(async () => {
    await fs.rm(repoRoot, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  execFileSync('git', ['init'], { cwd: repoRoot, stdio: 'ignore' });

  const manager = new RepoManager(loggerStub, securityStub, validationStub, null);

  await assert.rejects(
    () => manager.handleAction({ action: 'exec', repo_root: repoRoot, cwd: outside, command: 'git', args: ['status'] }),
    /escapes sandbox root/
  );

  await assert.rejects(
    () => manager.handleAction({ action: 'exec', repo_root: repoRoot, command: 'git', args: ['commit', '-m', 'x'] }),
    /requires apply=true/
  );

  const ok = await manager.handleAction({
    action: 'exec',
    repo_root: repoRoot,
    command: 'git',
    args: ['status'],
    trace_id: 'trace',
    span_id: 'span',
  });

  assert.equal(ok.exit_code, 0);
});

test('repo.exec allows read-only kubectl verbs without apply (including leading -n)', async () => {
  const manager = new RepoManager(loggerStub, securityStub, validationStub, null);

  assert.doesNotThrow(() => manager.ensureExecAllowed({
    command: 'kubectl',
    argv: ['-n', 'default', 'get', 'pods', '-o', 'name'],
    apply: false,
  }));

  assert.doesNotThrow(() => manager.ensureExecAllowed({
    command: 'kubectl',
    argv: ['--namespace', 'default', 'describe', 'pod', 'demo'],
    apply: false,
  }));

  assert.doesNotThrow(() => manager.ensureExecAllowed({
    command: 'kubectl',
    argv: ['-n', 'default', 'rollout', 'status', 'deployment/demo'],
    apply: false,
  }));

  assert.throws(
    () => manager.ensureExecAllowed({ command: 'kubectl', argv: ['-n', 'default', 'annotate', 'pod', 'demo', 'a=b'], apply: false }),
    /requires apply=true/
  );

  assert.throws(
    () => manager.ensureExecAllowed({ command: 'kubectl', argv: ['rollout', 'undo', 'deployment/demo'], apply: false }),
    /requires apply=true/
  );
});
