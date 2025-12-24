const test = require('node:test');
const assert = require('node:assert/strict');

const SSHManager = require('../src/managers/SSHManager.cjs');
const SecretRefResolver = require('../src/services/SecretRefResolver.cjs');

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

test('SSHManager materializeConnection resolves ref:env password', async (t) => {
  const previous = process.env.SF_SSH_PASS;
  process.env.SF_SSH_PASS = 'p@ss';

  t.after(() => {
    if (previous === undefined) {
      delete process.env.SF_SSH_PASS;
    } else {
      process.env.SF_SSH_PASS = previous;
    }
  });

  const secretRefResolver = new SecretRefResolver(loggerStub, { ensureString: (v) => v }, null, null, null);
  const manager = new SSHManager(loggerStub, securityStub, validationStub, null, null, secretRefResolver);

  const input = { host: '127.0.0.1', username: 'root', password: 'ref:env:SF_SSH_PASS' };
  const config = await manager.materializeConnection(input, {});

  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.username, 'root');
  assert.equal(config.password, 'p@ss');
  assert.equal(input.password, 'ref:env:SF_SSH_PASS', 'must not mutate input');
});

test('SSHManager materializeConnection resolves ref:env private_key and passphrase', async (t) => {
  const prevKey = process.env.SF_SSH_KEY;
  const prevPass = process.env.SF_SSH_PASSPHRASE;
  process.env.SF_SSH_KEY = 'KEYDATA';
  process.env.SF_SSH_PASSPHRASE = 'unlock';

  t.after(() => {
    if (prevKey === undefined) {
      delete process.env.SF_SSH_KEY;
    } else {
      process.env.SF_SSH_KEY = prevKey;
    }
    if (prevPass === undefined) {
      delete process.env.SF_SSH_PASSPHRASE;
    } else {
      process.env.SF_SSH_PASSPHRASE = prevPass;
    }
  });

  const secretRefResolver = new SecretRefResolver(loggerStub, { ensureString: (v) => v }, null, null, null);
  const manager = new SSHManager(loggerStub, securityStub, validationStub, null, null, secretRefResolver);

  const input = {
    host: 'example.com',
    username: 'deploy',
    private_key: 'ref:env:SF_SSH_KEY',
    passphrase: 'ref:env:SF_SSH_PASSPHRASE',
  };
  const config = await manager.materializeConnection(input, {});

  assert.equal(config.privateKey, 'KEYDATA');
  assert.equal(config.passphrase, 'unlock');
  assert.equal(input.private_key, 'ref:env:SF_SSH_KEY', 'must not mutate input');
});

