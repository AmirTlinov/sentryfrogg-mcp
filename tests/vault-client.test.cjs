const test = require('node:test');
const assert = require('node:assert/strict');
const VaultClient = require('../src/services/VaultClient.cjs');

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
    return value;
  },
};

function profileServiceStub(profile) {
  return {
    async getProfile(name, expectedType) {
      assert.equal(name, profile.name);
      assert.equal(expectedType, 'vault');
      return profile;
    },
  };
}

function makeFetchStub(routes) {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    const entry = routes.find((route) => String(url).includes(route.match));
    if (!entry) {
      return {
        ok: false,
        status: 404,
        async text() {
          return JSON.stringify({ errors: ['not found'] });
        },
      };
    }
    return {
      ok: entry.status >= 200 && entry.status < 300,
      status: entry.status,
      async text() {
        return JSON.stringify(entry.body);
      },
    };
  };
  return { fetch, calls };
}

test('VaultClient sysHealth sets headers and calls /v1/sys/health', async () => {
  const profile = {
    name: 'vault',
    type: 'vault',
    data: { addr: 'https://vault.example/' , namespace: 'team-a' },
    secrets: { token: 'token123' },
  };

  const { fetch, calls } = makeFetchStub([
    { match: '/v1/sys/health', status: 200, body: { initialized: true, sealed: false } },
  ]);

  const client = new VaultClient(loggerStub, validationStub, profileServiceStub(profile), { fetch });
  const result = await client.sysHealth('vault');
  assert.equal(result.initialized, true);

  assert.equal(calls.length, 1);
  assert.ok(String(calls[0].url).includes('/v1/sys/health'));
  assert.equal(calls[0].options.headers['X-Vault-Token'], 'token123');
  assert.equal(calls[0].options.headers['X-Vault-Namespace'], 'team-a');
});

test('VaultClient tokenLookupSelf requires token', async () => {
  const profile = {
    name: 'vault',
    type: 'vault',
    data: { addr: 'https://vault.example' },
    secrets: {},
  };

  const { fetch } = makeFetchStub([]);
  const client = new VaultClient(loggerStub, validationStub, profileServiceStub(profile), { fetch });
  await assert.rejects(() => client.tokenLookupSelf('vault'), /token is required/i);
});

test('VaultClient kv2Get reads key from KV v2 response', async () => {
  const profile = {
    name: 'vault',
    type: 'vault',
    data: { addr: 'https://vault.example' },
    secrets: { token: 'token123' },
  };

  const { fetch, calls } = makeFetchStub([
    {
      match: '/v1/secret/data/myapp/prod',
      status: 200,
      body: { data: { data: { DATABASE_URL: 'postgres://db' } } },
    },
  ]);

  const client = new VaultClient(loggerStub, validationStub, profileServiceStub(profile), { fetch });
  const value = await client.kv2Get('vault', 'secret/myapp/prod#DATABASE_URL');
  assert.equal(value, 'postgres://db');
  assert.equal(calls.length, 1);
  assert.ok(String(calls[0].url).includes('/v1/secret/data/myapp/prod'));
});

