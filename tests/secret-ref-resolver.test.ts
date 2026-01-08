// @ts-nocheck
const test = require('node:test');
const assert = require('node:assert/strict');

const SecretRefResolver = require('../src/services/SecretRefResolver');

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
};

test('SecretRefResolver resolves ref:env:* values', async (t) => {
  const previous = process.env.SF_TEST_SECRET;
  process.env.SF_TEST_SECRET = 'ok';

  t.after(() => {
    if (previous === undefined) {
      delete process.env.SF_TEST_SECRET;
    } else {
      process.env.SF_TEST_SECRET = previous;
    }
  });

  const resolver = new SecretRefResolver(loggerStub, validationStub, null, null, null);
  const resolved = await resolver.resolveDeep('ref:env:SF_TEST_SECRET', {});
  assert.equal(resolved, 'ok');
});

test('SecretRefResolver selects vault profile by args.vault_profile_name', async () => {
  const calls = [];
  const resolver = new SecretRefResolver(
    loggerStub,
    validationStub,
    { async listProfiles() { return [{ name: 'ignored' }]; } },
    { async kv2Get(profileName, ref) { calls.push({ profileName, ref }); return `v:${profileName}:${ref}`; } },
    { async resolveContext() { return { target: { vault_profile: 'ignored' } }; } }
  );

  const input = { db: 'ref:vault:kv2:secret/app#DATABASE_URL' };
  const resolved = await resolver.resolveDeep(input, { vault_profile_name: 'explicit' });

  assert.deepEqual(resolved, { db: 'v:explicit:secret/app#DATABASE_URL' });
  assert.deepEqual(input, { db: 'ref:vault:kv2:secret/app#DATABASE_URL' }, 'must not mutate input');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { profileName: 'explicit', ref: 'secret/app#DATABASE_URL' });
});

test('SecretRefResolver selects vault profile by project target', async () => {
  const calls = [];
  const resolver = new SecretRefResolver(
    loggerStub,
    validationStub,
    { async listProfiles() { return [{ name: 'ignored' }]; } },
    { async kv2Get(profileName, ref) { calls.push({ profileName, ref }); return `v:${profileName}:${ref}`; } },
    { async resolveContext() { return { target: { vault_profile: 'from-project' } }; } }
  );

  const resolved = await resolver.resolveDeep(
    { token: 'ref:vault:kv2:kv/app#token' },
    { project: 'demo', target: 'prod' }
  );

  assert.deepEqual(resolved, { token: 'v:from-project:kv/app#token' });
  assert.equal(calls[0].profileName, 'from-project');
});

test('SecretRefResolver selects vault profile when there is exactly one vault profile', async () => {
  const calls = [];
  const resolver = new SecretRefResolver(
    loggerStub,
    validationStub,
    { async listProfiles() { return [{ name: 'only' }]; } },
    { async kv2Get(profileName, ref) { calls.push({ profileName, ref }); return `v:${profileName}:${ref}`; } },
    { async resolveContext() { return null; } }
  );

  const resolved = await resolver.resolveDeep({ v: 'ref:vault:kv2:secret/app#k' }, {});
  assert.deepEqual(resolved, { v: 'v:only:secret/app#k' });
});

test('SecretRefResolver errors when multiple vault profiles exist and none is selected', async () => {
  const resolver = new SecretRefResolver(
    loggerStub,
    validationStub,
    { async listProfiles() { return [{ name: 'a' }, { name: 'b' }]; } },
    { async kv2Get() { return 'nope'; } },
    { async resolveContext() { return null; } }
  );

  await assert.rejects(
    () => resolver.resolveDeep('ref:vault:kv2:secret/app#k', {}),
    /vault profile is required when multiple vault profiles exist/
  );
});

test('SecretRefResolver errors on unknown ref scheme', async () => {
  const resolver = new SecretRefResolver(loggerStub, validationStub, null, null, null);
  await assert.rejects(
    () => resolver.resolveDeep('ref:unknown:thing', {}),
    /Unknown secret ref scheme: unknown/
  );
});

test('SecretRefResolver caches identical vault refs within a single resolveDeep call', async () => {
  const calls = [];
  const resolver = new SecretRefResolver(
    loggerStub,
    validationStub,
    { async listProfiles() { return [{ name: 'only' }]; } },
    { async kv2Get(profileName, ref) { calls.push({ profileName, ref }); return `v:${profileName}:${ref}`; } },
    null
  );

  const resolved = await resolver.resolveDeep({
    a: 'ref:vault:kv2:secret/app#k',
    b: 'ref:vault:kv2:secret/app#k',
  }, {});

  assert.deepEqual(resolved, { a: 'v:only:secret/app#k', b: 'v:only:secret/app#k' });
  assert.equal(calls.length, 1);
});

