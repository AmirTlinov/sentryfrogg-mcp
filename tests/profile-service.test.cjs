const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const ProfileService = require('../src/services/ProfileService.cjs');

const loggerStub = {
  child() {
    return this;
  },
  info() {},
  warn() {},
  error() {},
};

const createSecurityStub = () => ({
  async encrypt(value) {
    return `enc(${value})`;
  },
  async decrypt(value) {
    return value.replace(/^enc\(|\)$/g, '');
  },
});

test('ProfileService can remove stored secrets via null payload', async (t) => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sentryfrogg-profiles-'));
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

  const service = new ProfileService(loggerStub, createSecurityStub());
  await service.initialize();

  await service.setProfile('analytics', {
    type: 'postgresql',
    host: 'db.local',
    port: 5432,
    username: 'service',
    database: 'warehouse',
    ssl: false,
    password: 'initial-secret',
  });

  const stored = service.profiles.get('analytics');
  assert.ok(stored.secrets.password.startsWith('enc('));

  await service.setProfile('analytics', {
    type: 'postgresql',
    host: 'db.local',
    port: 5432,
    username: 'service',
    database: 'warehouse',
    ssl: false,
    password: null,
  });

  const updated = service.profiles.get('analytics');
  assert.ok(!updated.secrets || updated.secrets.password === undefined);
});
