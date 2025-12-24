const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Writable } = require('node:stream');

const ProjectService = require('../src/services/ProjectService.cjs');
const ProjectResolver = require('../src/services/ProjectResolver.cjs');
const ProfileService = require('../src/services/ProfileService.cjs');
const EnvManager = require('../src/managers/EnvManager.cjs');
const SSHManager = require('../src/managers/SSHManager.cjs');

const loggerStub = {
  child() {
    return this;
  },
  info() {},
  warn() {},
  error() {},
};

const validationStub = {
  ensureString(value, _label, { trim = true } = {}) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error('invalid');
    }
    return trim ? value.trim() : value;
  },
  ensurePort(value, fallback) {
    return value ?? fallback;
  },
};

const securityStub = {
  async encrypt(value) {
    return `enc(${value})`;
  },
  async decrypt(value) {
    return value.replace(/^enc\(|\)$/g, '');
  },
  cleanCommand(value) {
    return value;
  },
};

test('ProjectService stores targets with ssh/env profile bindings', async (t) => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sentryfrogg-projects-'));
  const previousDir = process.env.MCP_PROFILES_DIR;
  process.env.MCP_PROFILES_DIR = tmpRoot;

  t.after(async () => {
    if (previousDir === undefined) {
      delete process.env.MCP_PROFILES_DIR;
    } else {
      process.env.MCP_PROFILES_DIR = previousDir;
    }
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  const service = new ProjectService(loggerStub);
  await service.initialize();

  await service.setProject('myapp', {
    default_target: 'prod',
    targets: {
      prod: {
        ssh_profile: 'myapp-prod',
        env_profile: 'myapp-prod-env',
        postgres_profile: 'myapp-prod-db',
        api_profile: 'myapp-prod-api',
        cwd: '/opt/myapp',
        env_path: '/opt/myapp/.env',
      },
    },
  });

  const stored = await service.getProject('myapp');
  assert.equal(stored.project.name, 'myapp');
  assert.equal(stored.project.default_target, 'prod');
  assert.equal(stored.project.targets.prod.ssh_profile, 'myapp-prod');
  assert.equal(stored.project.targets.prod.postgres_profile, 'myapp-prod-db');
});

test('SSHManager resolves ssh profile via project target (and active project)', async () => {
  const calls = { profile: null };
  const profileServiceStub = {
    async listProfiles() {
      return [];
    },
    async getProfile(name) {
      calls.profile = name;
      return { data: { host: '127.0.0.1', username: 'root', port: 22 }, secrets: {} };
    },
  };

  const projectServiceStub = {
    async getProject() {
      return {
        project: {
          default_target: 'prod',
          targets: {
            prod: { ssh_profile: 'ssh-prod' },
          },
        },
      };
    },
  };

  const stateServiceStub = {
    async get() {
      return { value: 'myapp' };
    },
  };

  const resolver = new ProjectResolver(validationStub, projectServiceStub, stateServiceStub);
  const manager = new SSHManager(loggerStub, securityStub, validationStub, profileServiceStub, resolver);

  const resolved1 = await manager.resolveConnection({ project: 'myapp', target: 'prod' });
  assert.equal(resolved1.profileName, 'ssh-prod');
  assert.equal(calls.profile, 'ssh-prod');

  calls.profile = null;
  const resolved2 = await manager.resolveConnection({ target: 'prod' });
  assert.equal(resolved2.profileName, 'ssh-prod');
  assert.equal(calls.profile, 'ssh-prod');
});

test('EnvManager write_remote uploads deterministic dotenv content (no values in response)', async (t) => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sentryfrogg-env-'));
  const previousDir = process.env.MCP_PROFILES_DIR;
  process.env.MCP_PROFILES_DIR = tmpRoot;

  t.after(async () => {
    if (previousDir === undefined) {
      delete process.env.MCP_PROFILES_DIR;
    } else {
      process.env.MCP_PROFILES_DIR = previousDir;
    }
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  const profileService = new ProfileService(loggerStub, securityStub);
  await profileService.initialize();

  const capture = { content: null, chmod: [], renames: [], exec: null };
  const files = new Map();
  const sshManagerStub = {
    async withSftp(_args, handler) {
      return handler({
        stat(filePath, cb) {
          if (files.has(filePath)) {
            cb(null, {});
            return;
          }
          const error = new Error('missing');
          error.code = 2;
          cb(error);
        },
        createWriteStream(remotePath) {
          const chunks = [];
          const stream = new Writable({
            write(chunk, _enc, cb) {
              chunks.push(Buffer.from(chunk).toString('utf8'));
              cb();
            },
          });
          stream.on('finish', () => {
            files.set(remotePath, chunks.join(''));
            capture.content = files.get('/opt/app/.env') || null;
          });
          return stream;
        },
        rename(fromPath, toPath, cb) {
          capture.renames.push([fromPath, toPath]);
          files.set(toPath, files.get(fromPath));
          files.delete(fromPath);
          capture.content = files.get('/opt/app/.env') || null;
          cb(null);
        },
        unlink(filePath, cb) {
          files.delete(filePath);
          cb(null);
        },
        chmod(filePath, mode, cb) {
          capture.chmod.push({ path: filePath, mode });
          cb(null);
        },
      });
    },
    async ensureRemoteDir() {},
    async execCommand(args) {
      capture.exec = args;
      return { exitCode: 0, stdout: 'ok', stderr: '', command: args.command, signal: null, timedOut: false, duration_ms: 1 };
    },
  };

  const envManager = new EnvManager(loggerStub, validationStub, profileService, sshManagerStub, null);

  await envManager.profileUpsert('bundle', {
    secrets: {
      B: 'hello world',
      A: '1',
      C: 'line\nbreak',
    },
  });

  const result = await envManager.writeRemote({
    profile_name: 'bundle',
    ssh_profile_name: 'ssh1',
    remote_path: '/opt/app/.env',
    mkdirs: true,
    mode: 0o600,
  });

  assert.equal(result.success, true);
  assert.equal(result.remote_path, '/opt/app/.env');
  assert.deepEqual(result.variables.keys, ['A', 'B', 'C']);

  assert.equal(capture.content, 'A="1"\nB="hello world"\nC="line\\nbreak"\n');
  assert.ok(capture.renames.some(([, to]) => to === '/opt/app/.env'));
  assert.ok(capture.chmod.some((entry) => entry.path === '/opt/app/.env' && entry.mode === 0o600));
});

test('EnvManager write_remote refuses to overwrite existing remote_path by default', async (t) => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sentryfrogg-env-'));
  const previousDir = process.env.MCP_PROFILES_DIR;
  process.env.MCP_PROFILES_DIR = tmpRoot;

  t.after(async () => {
    if (previousDir === undefined) {
      delete process.env.MCP_PROFILES_DIR;
    } else {
      process.env.MCP_PROFILES_DIR = previousDir;
    }
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  const profileService = new ProfileService(loggerStub, securityStub);
  await profileService.initialize();

  const files = new Map([['/opt/app/.env', 'EXISTING=1\n']]);
  const sshManagerStub = {
    async withSftp(_args, handler) {
      return handler({
        stat(filePath, cb) {
          if (files.has(filePath)) {
            cb(null, {});
            return;
          }
          const error = new Error('missing');
          error.code = 2;
          cb(error);
        },
        createWriteStream() {
          throw new Error('should not write when overwrite=false');
        },
        rename(_from, _to, cb) {
          cb(new Error('should not rename when overwrite=false'));
        },
        unlink(_path, cb) {
          cb(null);
        },
      });
    },
    async ensureRemoteDir() {},
    async execCommand() {
      throw new Error('not used');
    },
  };

  const envManager = new EnvManager(loggerStub, validationStub, profileService, sshManagerStub, null);

  await envManager.profileUpsert('bundle', {
    secrets: { A: '1' },
  });

  await assert.rejects(
    () => envManager.writeRemote({
      profile_name: 'bundle',
      ssh_profile_name: 'ssh1',
      remote_path: '/opt/app/.env',
    }),
    /Remote path already exists/
  );
});

test('EnvManager write_remote defaults remote_path from project target.env_path', async (t) => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sentryfrogg-env-'));
  const previousDir = process.env.MCP_PROFILES_DIR;
  process.env.MCP_PROFILES_DIR = tmpRoot;

  t.after(async () => {
    if (previousDir === undefined) {
      delete process.env.MCP_PROFILES_DIR;
    } else {
      process.env.MCP_PROFILES_DIR = previousDir;
    }
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  const profileService = new ProfileService(loggerStub, securityStub);
  await profileService.initialize();

  const projectServiceStub = {
    async getProject() {
      return {
        project: {
          default_target: 'prod',
          targets: {
            prod: { env_path: '/opt/app/.env', cwd: '/opt/app' },
          },
        },
      };
    },
  };

  const stateServiceStub = {
    async get() {
      return { value: 'myapp' };
    },
  };

  const resolver = new ProjectResolver(validationStub, projectServiceStub, stateServiceStub);

  const files = new Map();
  const sshManagerStub = {
    async withSftp(_args, handler) {
      return handler({
        stat(filePath, cb) {
          if (files.has(filePath)) {
            cb(null, {});
            return;
          }
          const error = new Error('missing');
          error.code = 2;
          cb(error);
        },
        createWriteStream(remotePath) {
          const chunks = [];
          const stream = new Writable({
            write(chunk, _enc, cb) {
              chunks.push(Buffer.from(chunk).toString('utf8'));
              cb();
            },
          });
          stream.on('finish', () => {
            files.set(remotePath, chunks.join(''));
          });
          return stream;
        },
        rename(fromPath, toPath, cb) {
          files.set(toPath, files.get(fromPath));
          files.delete(fromPath);
          cb(null);
        },
        unlink(filePath, cb) {
          files.delete(filePath);
          cb(null);
        },
      });
    },
    async ensureRemoteDir() {},
    async execCommand() {
      throw new Error('not used');
    },
  };

  const envManager = new EnvManager(loggerStub, validationStub, profileService, sshManagerStub, resolver);

  await envManager.profileUpsert('bundle', { secrets: { A: '1' } });

  const result = await envManager.writeRemote({
    profile_name: 'bundle',
    ssh_profile_name: 'ssh1',
    target: 'prod',
    mkdirs: true,
  });

  assert.equal(result.remote_path, '/opt/app/.env');
  assert.equal(files.get('/opt/app/.env'), 'A="1"\n');
});

test('EnvManager run_remote defaults cwd from project target.cwd', async (t) => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sentryfrogg-env-'));
  const previousDir = process.env.MCP_PROFILES_DIR;
  process.env.MCP_PROFILES_DIR = tmpRoot;

  t.after(async () => {
    if (previousDir === undefined) {
      delete process.env.MCP_PROFILES_DIR;
    } else {
      process.env.MCP_PROFILES_DIR = previousDir;
    }
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  const profileService = new ProfileService(loggerStub, securityStub);
  await profileService.initialize();

  const projectServiceStub = {
    async getProject() {
      return {
        project: {
          default_target: 'prod',
          targets: {
            prod: { cwd: '/opt/app' },
          },
        },
      };
    },
  };

  const stateServiceStub = {
    async get() {
      return { value: 'myapp' };
    },
  };

  const resolver = new ProjectResolver(validationStub, projectServiceStub, stateServiceStub);

  let received;
  const sshManagerStub = {
    async execCommand(args) {
      received = args;
      return { exitCode: 0, stdout: 'ok', stderr: '', command: args.command, signal: null, timedOut: false, duration_ms: 1 };
    },
  };

  const envManager = new EnvManager(loggerStub, validationStub, profileService, sshManagerStub, resolver);

  await envManager.profileUpsert('bundle', { secrets: { A: '1' } });

  await envManager.runRemote({
    profile_name: 'bundle',
    ssh_profile_name: 'ssh1',
    target: 'prod',
    command: 'pwd',
  });

  assert.equal(received.cwd, '/opt/app');
});
