// @ts-nocheck
const test = require('node:test');
const assert = require('node:assert/strict');

const PostgreSQLManager = require('../src/managers/PostgreSQLManager');
const SecretRefResolver = require('../src/services/SecretRefResolver');

const loggerStub = {
  child() {
    return this;
  },
  info() {},
  warn() {},
  error() {},
};

const validationStub = {};

test('PostgreSQLManager resolves ref:env password and ssl fields in resolveConnection', async (t) => {
  const prevPass = process.env.SF_PG_PASS;
  const prevCa = process.env.SF_PG_CA;
  process.env.SF_PG_PASS = 'secret';
  process.env.SF_PG_CA = 'CA_CERT';

  t.after(() => {
    if (prevPass === undefined) {
      delete process.env.SF_PG_PASS;
    } else {
      process.env.SF_PG_PASS = prevPass;
    }
    if (prevCa === undefined) {
      delete process.env.SF_PG_CA;
    } else {
      process.env.SF_PG_CA = prevCa;
    }
  });

  const secretRefResolver = new SecretRefResolver(loggerStub, { ensureString: (v) => v }, null, null, null);
  const manager = new PostgreSQLManager(loggerStub, validationStub, null, null, secretRefResolver);

  const input = {
    host: 'db.example',
    username: 'app',
    database: 'app',
    password: 'ref:env:SF_PG_PASS',
    ssl: { ca: 'ref:env:SF_PG_CA' },
  };

  const resolved = await manager.resolveConnection({ connection: input });

  assert.equal(resolved.connection.password, 'secret');
  assert.equal(resolved.connection.ssl.ca, 'CA_CERT');
  assert.equal(input.password, 'ref:env:SF_PG_PASS', 'must not mutate input');
});

