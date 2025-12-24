const test = require('node:test');
const assert = require('node:assert/strict');

const SSHManager = require('../src/managers/SSHManager.cjs');
const PostgreSQLManager = require('../src/managers/PostgreSQLManager.cjs');
const APIManager = require('../src/managers/APIManager.cjs');

const loggerStub = {
  child() {
    return this;
  },
  info() {},
  warn() {},
  error() {},
};

const validationStub = {
  ensureString(value) {
    return String(value);
  },
  ensureHeaders(headers) {
    return headers ?? {};
  },
};

const securityStub = {
  ensureUrl(url) {
    return new URL(url);
  },
  cleanCommand(value) {
    return value;
  },
};

function setExportFlag(t, value) {
  const prevA = process.env.SENTRYFROGG_ALLOW_SECRET_EXPORT;
  const prevB = process.env.SF_ALLOW_SECRET_EXPORT;

  if (value === null) {
    delete process.env.SENTRYFROGG_ALLOW_SECRET_EXPORT;
    delete process.env.SF_ALLOW_SECRET_EXPORT;
  } else {
    process.env.SENTRYFROGG_ALLOW_SECRET_EXPORT = value;
    delete process.env.SF_ALLOW_SECRET_EXPORT;
  }

  t.after(() => {
    if (prevA === undefined) {
      delete process.env.SENTRYFROGG_ALLOW_SECRET_EXPORT;
    } else {
      process.env.SENTRYFROGG_ALLOW_SECRET_EXPORT = prevA;
    }
    if (prevB === undefined) {
      delete process.env.SF_ALLOW_SECRET_EXPORT;
    } else {
      process.env.SF_ALLOW_SECRET_EXPORT = prevB;
    }
  });
}

test('SSHManager profile_get does not export secrets without break-glass flag', async (t) => {
  setExportFlag(t, null);

  const profileServiceStub = {
    async getProfile() {
      return { name: 'ssh1', type: 'ssh', data: { host: 'example' }, secrets: { password: 'pw' } };
    },
  };

  const manager = new SSHManager(loggerStub, securityStub, validationStub, profileServiceStub);
  const response = await manager.profileGet('ssh1', true);

  assert.equal(response.success, true);
  assert.equal(response.profile.secrets_redacted, true);
  assert.deepEqual(response.profile.secrets, ['password']);
});

test('SSHManager profile_get exports secrets with break-glass flag', async (t) => {
  setExportFlag(t, '1');

  const profileServiceStub = {
    async getProfile() {
      return { name: 'ssh1', type: 'ssh', data: { host: 'example' }, secrets: { password: 'pw' } };
    },
  };

  const manager = new SSHManager(loggerStub, securityStub, validationStub, profileServiceStub);
  const response = await manager.profileGet('ssh1', true);

  assert.equal(response.profile.secrets.password, 'pw');
});

test('PostgreSQLManager profile_get does not export secrets without break-glass flag', async (t) => {
  setExportFlag(t, null);

  const profileServiceStub = {
    async getProfile() {
      return { name: 'db1', type: 'postgresql', data: { host: 'db' }, secrets: { password: 'pw' } };
    },
  };

  const manager = new PostgreSQLManager(loggerStub, validationStub, profileServiceStub);
  const response = await manager.profileGet('db1', true);

  assert.equal(response.profile.secrets_redacted, true);
  assert.deepEqual(response.profile.secrets, ['password']);
});

test('APIManager profile_get does not export secrets without break-glass flag', async (t) => {
  setExportFlag(t, null);

  const profileServiceStub = {
    async getProfile() {
      return { name: 'api1', type: 'api', data: { base_url: 'https://example.com' }, secrets: { auth_token: 'pw' } };
    },
  };

  const manager = new APIManager(loggerStub, securityStub, validationStub, profileServiceStub, null);
  const response = await manager.profileGet('api1', true);

  assert.equal(response.profile.secrets_redacted, true);
  assert.deepEqual(response.profile.secrets, ['auth_token']);
});

