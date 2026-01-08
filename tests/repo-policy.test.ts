// @ts-nocheck
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const RepoManager = require('../src/managers/RepoManager');
const PolicyService = require('../src/services/PolicyService');
const ToolError = require('../src/errors/ToolError');

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
    return String(value).trim();
  },
  ensureSizeFits() {},
};

const validationStub = {
  ensureString(value, _label, { trim = true } = {}) {
    const text = String(value);
    return trim ? text.trim() : text;
  },
};

async function makeTempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeKubectlStub(dir) {
  const scriptPath = path.join(dir, 'kubectl');
  const body = `#!/usr/bin/env node
process.stdout.write('ok\\n');
process.exit(0);
`;
  await fs.writeFile(scriptPath, body, { encoding: 'utf8', mode: 0o755 });
  return scriptPath;
}

test('RepoManager enforces policy.repo.allowed_remotes for git_push', async (t) => {
  const repoRoot = await makeTempDir('sf-repo-policy-git-');
  const remoteRoot = await makeTempDir('sf-repo-policy-remote-');

  t.after(async () => {
    await fs.rm(repoRoot, { recursive: true, force: true });
    await fs.rm(remoteRoot, { recursive: true, force: true });
  });

  execFileSync('git', ['init', '-b', 'main'], { cwd: repoRoot, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot, stdio: 'ignore' });

  await fs.writeFile(path.join(repoRoot, 'hello.txt'), 'hello\n', 'utf8');
  execFileSync('git', ['add', 'hello.txt'], { cwd: repoRoot, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoRoot, stdio: 'ignore' });

  execFileSync('git', ['init', '--bare'], { cwd: remoteRoot, stdio: 'ignore' });
  execFileSync('git', ['remote', 'add', 'origin', remoteRoot], { cwd: repoRoot, stdio: 'ignore' });

  const projectResolverStub = {
    async resolveContext() {
      return {
        projectName: 'demo',
        targetName: 'prod',
        target: {
          cwd: repoRoot,
          policy: {
            mode: 'operatorless',
            lock: { enabled: false },
            repo: { allowed_remotes: ['upstream'] },
          },
        },
      };
    },
  };

  const policyService = new PolicyService(loggerStub, {}, null);
  const manager = new RepoManager(loggerStub, securityStub, validationStub, projectResolverStub, policyService);

  await assert.rejects(
    () => manager.handleAction({
      action: 'git_push',
      project: 'demo',
      target: 'prod',
      remote: 'origin',
      branch: 'main',
      apply: true,
      trace_id: 'trace-1',
    }),
    (error) => {
      assert.equal(ToolError.isToolError(error), true);
      assert.equal(error.kind, 'denied');
      assert.equal(error.code, 'POLICY_DENIED_REMOTE');
      return true;
    }
  );
});

test('RepoManager enforces policy.kubernetes.allowed_namespaces for kubectl write exec', async (t) => {
  const repoRoot = await makeTempDir('sf-repo-policy-kubectl-');
  const stubDir = await makeTempDir('sf-kubectl-policy-stub-');
  await writeKubectlStub(stubDir);

  const prevAllowed = process.env.SF_REPO_ALLOWED_COMMANDS;
  const prevPath = process.env.PATH;
  process.env.SF_REPO_ALLOWED_COMMANDS = 'git,kubectl';
  process.env.PATH = `${stubDir}:${prevPath}`;

  t.after(async () => {
    if (prevAllowed === undefined) {
      delete process.env.SF_REPO_ALLOWED_COMMANDS;
    } else {
      process.env.SF_REPO_ALLOWED_COMMANDS = prevAllowed;
    }
    process.env.PATH = prevPath;
    await fs.rm(repoRoot, { recursive: true, force: true });
    await fs.rm(stubDir, { recursive: true, force: true });
  });

  const projectResolverStub = {
    async resolveContext() {
      return {
        projectName: 'demo',
        targetName: 'prod',
        target: {
          cwd: repoRoot,
          policy: {
            mode: 'operatorless',
            lock: { enabled: false },
            kubernetes: { allowed_namespaces: ['prod'] },
          },
        },
      };
    },
  };

  const policyService = new PolicyService(loggerStub, {}, null);
  const manager = new RepoManager(loggerStub, securityStub, validationStub, projectResolverStub, policyService);

  await assert.rejects(
    () => manager.handleAction({
      action: 'exec',
      project: 'demo',
      target: 'prod',
      apply: true,
      command: 'kubectl',
      args: ['annotate', 'pod', 'demo', 'a=b', '-n', 'default'],
    }),
    (error) => {
      assert.equal(ToolError.isToolError(error), true);
      assert.equal(error.kind, 'denied');
      assert.equal(error.code, 'POLICY_DENIED_NAMESPACE');
      return true;
    }
  );

  const ok = await manager.handleAction({
    action: 'exec',
    project: 'demo',
    target: 'prod',
    apply: true,
    command: 'kubectl',
    args: ['annotate', 'pod', 'demo', 'a=b', '-n', 'prod'],
    inline: true,
  });

  assert.equal(ok.success, true);
  assert.equal(ok.stdout_inline, 'ok');
});
