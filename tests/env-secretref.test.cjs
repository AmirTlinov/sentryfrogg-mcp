const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Writable } = require('node:stream');

const ProfileService = require('../src/services/ProfileService.cjs');
const EnvManager = require('../src/managers/EnvManager.cjs');

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

test('EnvManager resolves ref:vault:kv2 values when writing remote env', async (t) => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sentryfrogg-env-ref-'));
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

  const vaultCalls = [];
  const vaultClientStub = {
    async kv2Get(profileName, ref) {
      vaultCalls.push({ profileName, ref });
      return 'postgres://db';
    },
  };

  const capture = { content: null };
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
          files.set(toPath, files.get(fromPath));
          files.delete(fromPath);
          capture.content = files.get('/opt/app/.env') || null;
          cb(null);
        },
        unlink(filePath, cb) {
          files.delete(filePath);
          cb(null);
        },
        chmod(_filePath, _mode, cb) {
          cb(null);
        },
      });
    },
    async ensureRemoteDir() {},
  };

  const envManager = new EnvManager(loggerStub, validationStub, profileService, sshManagerStub, null, vaultClientStub);

  await envManager.profileUpsert('bundle', {
    secrets: {
      DATABASE_URL: 'ref:vault:kv2:secret/myapp/prod#DATABASE_URL',
    },
  });

  const result = await envManager.writeRemote({
    profile_name: 'bundle',
    ssh_profile_name: 'ssh1',
    vault_profile_name: 'vault1',
    remote_path: '/opt/app/.env',
    mkdirs: true,
  });

  assert.equal(result.success, true);
  assert.deepEqual(result.variables.keys, ['DATABASE_URL']);
  assert.equal(capture.content, 'DATABASE_URL="postgres://db"\n');
  assert.deepEqual(vaultCalls, [{ profileName: 'vault1', ref: 'secret/myapp/prod#DATABASE_URL' }]);
});

test('EnvManager can infer vault profile from project target', async (t) => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sentryfrogg-env-ref-proj-'));
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

  const vaultCalls = [];
  const vaultClientStub = {
    async kv2Get(profileName, ref) {
      vaultCalls.push({ profileName, ref });
      return 'postgres://db';
    },
  };

  const projectResolverStub = {
    async resolveContext() {
      return { target: { vault_profile: 'vault-prod' } };
    },
  };

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
          const stream = new Writable({
            write(_chunk, _enc, cb) {
              cb();
            },
          });
          stream.on('finish', () => {
            files.set(remotePath, 'ok');
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
        chmod(_filePath, _mode, cb) {
          cb(null);
        },
      });
    },
    async ensureRemoteDir() {},
  };

  const envManager = new EnvManager(loggerStub, validationStub, profileService, sshManagerStub, projectResolverStub, vaultClientStub);

  await envManager.profileUpsert('bundle', {
    secrets: {
      DATABASE_URL: 'ref:vault:kv2:secret/myapp/prod#DATABASE_URL',
    },
  });

  const result = await envManager.writeRemote({
    profile_name: 'bundle',
    ssh_profile_name: 'ssh1',
    target: 'prod',
    remote_path: '/opt/app/.env',
  });

  assert.equal(result.success, true);
  assert.deepEqual(vaultCalls, [{ profileName: 'vault-prod', ref: 'secret/myapp/prod#DATABASE_URL' }]);
});
