// @ts-nocheck
const test = require('node:test');
const assert = require('node:assert/strict');

const APIManager = require('../src/managers/APIManager');
const SecretRefResolver = require('../src/services/SecretRefResolver');

const loggerStub = {
  child() {
    return this;
  },
  error() {},
  warn() {},
  info() {},
};

const securityStub = {
  ensureUrl(url) {
    return new URL(url);
  },
};

const validationStub = {
  ensureHeaders(headers) {
    return headers ?? {};
  },
  ensureString(value) {
    return value;
  },
};

test('APIManager resolves SecretRefs inside resolved profile auth/auth_provider', async (t) => {
  const prevToken = process.env.SF_API_TOKEN;
  const prevSecret = process.env.SF_API_CLIENT_SECRET;
  process.env.SF_API_TOKEN = 'token';
  process.env.SF_API_CLIENT_SECRET = 'shh';

  t.after(() => {
    if (prevToken === undefined) {
      delete process.env.SF_API_TOKEN;
    } else {
      process.env.SF_API_TOKEN = prevToken;
    }
    if (prevSecret === undefined) {
      delete process.env.SF_API_CLIENT_SECRET;
    } else {
      process.env.SF_API_CLIENT_SECRET = prevSecret;
    }
  });

  const profileServiceStub = {
    async getProfile() {
      return {
        data: {
          auth: { type: 'bearer' },
          auth_provider: { type: 'oauth2', token_url: 'https://idp/token', client_id: 'cid' },
        },
        secrets: {
          auth_token: 'ref:env:SF_API_TOKEN',
          auth_provider_client_secret: 'ref:env:SF_API_CLIENT_SECRET',
        },
      };
    },
    async listProfiles() {
      return [];
    },
  };

  const secretRefResolver = new SecretRefResolver(loggerStub, { ensureString: (v) => v }, null, null, null);
  const manager = new APIManager(loggerStub, securityStub, validationStub, profileServiceStub, null, { secretRefResolver });

  const profile = await manager.resolveProfile('api1', {});
  assert.equal(profile.auth.token, 'token');
  assert.equal(profile.authProvider.client_secret, 'shh');
});

test('APIManager resolves SecretRefs inside auth_provider (static token)', async (t) => {
  const prevToken = process.env.SF_API_TOKEN;
  process.env.SF_API_TOKEN = 'token';

  t.after(() => {
    if (prevToken === undefined) {
      delete process.env.SF_API_TOKEN;
    } else {
      process.env.SF_API_TOKEN = prevToken;
    }
  });

  const secretRefResolver = new SecretRefResolver(loggerStub, { ensureString: (v) => v }, null, null, null);
  const manager = new APIManager(loggerStub, securityStub, validationStub, { async listProfiles() { return []; } }, null, { secretRefResolver });

  const auth = await manager.resolveAuthProvider({ type: 'static', token: 'ref:env:SF_API_TOKEN' }, 'inline', {});
  assert.deepEqual(auth, { type: 'bearer', token: 'token' });
});

