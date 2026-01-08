// @ts-nocheck
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const SSHManager = require('../src/managers/SSHManager');

const loggerStub = {
  child() {
    return this;
  },
  info() {},
  warn() {},
  error() {},
};

const validationStub = {
  ensurePort(value, fallback) {
    return value ?? fallback;
  },
};

const securityStub = {
  cleanCommand(value) {
    return value;
  },
};

function fpSha256(buffer) {
  const hash = crypto.createHash('sha256').update(buffer).digest('base64');
  return `SHA256:${hash.replace(/=+$/g, '')}`;
}

test('SSHManager host_key_policy=pin rejects mismatched host key', async () => {
  const manager = new SSHManager(loggerStub, securityStub, validationStub, null, null, null);
  const key = Buffer.from('hostkey');
  const expected = fpSha256(key);

  const config = await manager.materializeConnection({
    host: 'example.com',
    username: 'root',
    password: 'pw',
    host_key_policy: 'pin',
    host_key_fingerprint_sha256: expected,
  }, {});

  assert.equal(typeof config.hostVerifier, 'function');
  assert.equal(config.hostVerifier(key), true);
  assert.equal(config.hostVerifier(Buffer.from('other')), false);
});

test('SSHManager host_key_policy=pin requires host_key_fingerprint_sha256', async () => {
  const manager = new SSHManager(loggerStub, securityStub, validationStub, null, null, null);
  await assert.rejects(
    () => manager.materializeConnection({
      host: 'example.com',
      username: 'root',
      password: 'pw',
      host_key_policy: 'pin',
    }, {}),
    /host_key_fingerprint_sha256 is required/
  );
});

test('SSHManager defaults to pin when host_key_fingerprint_sha256 is present', async () => {
  const manager = new SSHManager(loggerStub, securityStub, validationStub, null, null, null);
  const key = Buffer.from('hostkey');
  const expected = fpSha256(key);

  const config = await manager.materializeConnection({
    host: 'example.com',
    username: 'root',
    password: 'pw',
    host_key_fingerprint_sha256: expected,
  }, {});

  assert.equal(typeof config.hostVerifier, 'function');
  assert.equal(config.hostVerifier(key), true);
  assert.equal(config.hostVerifier(Buffer.from('other')), false);
});

test('SSHManager TOFU captures host key and persists fingerprint into profile', async () => {
  const calls = [];
  const profileServiceStub = {
    async setProfile(name, payload) {
      calls.push({ name, payload });
    },
  };

  const manager = new SSHManager(loggerStub, securityStub, validationStub, profileServiceStub, null, null);
  const key = Buffer.from('hostkey');
  const expected = fpSha256(key);

  const config = await manager.materializeConnection({
    host: 'example.com',
    username: 'root',
    password: 'pw',
    host_key_policy: 'tofu',
  }, {});

  assert.equal(typeof config.hostVerifier, 'function');
  assert.equal(config.hostVerifier(key), true);

  const state = config.__sentryfrogg_host_key_state;
  assert.equal(state.policy, 'tofu');
  assert.equal(state.tofu_persist, true);
  assert.equal(state.observed_fingerprint_sha256, expected);

  const persisted = await manager.maybePersistTofuHostKey('ssh1', state);
  assert.equal(persisted, true);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'ssh1');
  assert.equal(calls[0].payload.type, 'ssh');
  assert.equal(calls[0].payload.data.host_key_policy, 'tofu');
  assert.equal(calls[0].payload.data.host_key_fingerprint_sha256, expected);
});

test('SSHManager accepts base64-only host_key_fingerprint_sha256 input (without SHA256: prefix)', async () => {
  const manager = new SSHManager(loggerStub, securityStub, validationStub, null, null, null);
  const key = Buffer.from('hostkey');
  const expected = fpSha256(key);
  const base64Only = expected.replace(/^SHA256:/, '');

  const config = await manager.materializeConnection({
    host: 'example.com',
    username: 'root',
    password: 'pw',
    host_key_policy: 'pin',
    host_key_fingerprint_sha256: base64Only,
  }, {});

  assert.equal(config.hostVerifier(key), true);
});

test('SSHManager withClient reuses in-flight connection creation', async () => {
  const profileServiceStub = {
    async getProfile() {
      return {
        name: 'ssh1',
        type: 'ssh',
        data: { host: 'example.com', username: 'root' },
        secrets: { password: 'pw' },
      };
    },
  };

  const manager = new SSHManager(loggerStub, securityStub, validationStub, profileServiceStub, null, null);

  let created = 0;
  manager.createClient = async () => {
    created += 1;
    return { client: {}, busy: null, closed: false };
  };

  const seen = [];
  await Promise.all([
    manager.withClient('ssh1', async () => {
      seen.push('a');
    }),
    manager.withClient('ssh1', async () => {
      seen.push('b');
    }),
  ]);

  assert.equal(created, 1);
  assert.equal(seen.length, 2);
});
