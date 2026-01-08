"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// @ts-nocheck
const test = require('node:test');
const assert = require('node:assert/strict');
const VaultClient = require('../src/services/VaultClient');
const loggerStub = {
    child() {
        return this;
    },
    info() { },
    warn() { },
    error() { },
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
        data: { addr: 'https://vault.example/', namespace: 'team-a' },
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
test('VaultClient kv2Get auto-logins via AppRole and persists token', async () => {
    const profile = {
        name: 'vault',
        type: 'vault',
        data: { addr: 'https://vault.example' },
        secrets: { role_id: 'role-1', secret_id: 'secret-1' },
    };
    let persisted = null;
    const profileService = {
        async getProfile(name, expectedType) {
            assert.equal(name, 'vault');
            assert.equal(expectedType, 'vault');
            return profile;
        },
        async setProfile(name, config) {
            assert.equal(name, 'vault');
            assert.equal(config.type, 'vault');
            persisted = config.secrets.token;
            profile.secrets.token = persisted;
        },
    };
    const { fetch, calls } = makeFetchStub([
        {
            match: '/v1/auth/approle/login',
            status: 200,
            body: { auth: { client_token: 'token123' } },
        },
        {
            match: '/v1/secret/data/myapp/prod',
            status: 200,
            body: { data: { data: { DATABASE_URL: 'postgres://db' } } },
        },
    ]);
    const client = new VaultClient(loggerStub, validationStub, profileService, { fetch });
    const value = await client.kv2Get('vault', 'secret/myapp/prod#DATABASE_URL');
    assert.equal(value, 'postgres://db');
    assert.equal(persisted, 'token123');
    assert.equal(calls.length, 2);
    assert.ok(String(calls[0].url).includes('/v1/auth/approle/login'));
    assert.equal(calls[0].options.method, 'POST');
    assert.ok(String(calls[1].url).includes('/v1/secret/data/myapp/prod'));
    assert.equal(calls[1].options.headers['X-Vault-Token'], 'token123');
});
test('VaultClient kv2Get retries with AppRole token when existing token is rejected', async () => {
    const profile = {
        name: 'vault',
        type: 'vault',
        data: { addr: 'https://vault.example' },
        secrets: { token: 'badtoken', role_id: 'role-1', secret_id: 'secret-1' },
    };
    const calls = [];
    let persisted = null;
    const profileService = {
        async getProfile() {
            return profile;
        },
        async setProfile(_name, config) {
            persisted = config.secrets.token;
            profile.secrets.token = persisted;
        },
    };
    const fetchStub = async (url, options) => {
        calls.push({ url: String(url), options });
        if (String(url).includes('/v1/secret/data/myapp/prod')) {
            const token = options.headers['X-Vault-Token'];
            if (token === 'badtoken') {
                return {
                    ok: false,
                    status: 403,
                    async text() {
                        return JSON.stringify({ errors: ['permission denied'] });
                    },
                };
            }
            return {
                ok: true,
                status: 200,
                async text() {
                    return JSON.stringify({ data: { data: { DATABASE_URL: 'postgres://db' } } });
                },
            };
        }
        if (String(url).includes('/v1/auth/approle/login')) {
            return {
                ok: true,
                status: 200,
                async text() {
                    return JSON.stringify({ auth: { client_token: 'goodtoken' } });
                },
            };
        }
        return {
            ok: false,
            status: 404,
            async text() {
                return JSON.stringify({ errors: ['not found'] });
            },
        };
    };
    const client = new VaultClient(loggerStub, validationStub, profileService, { fetch: fetchStub });
    const value = await client.kv2Get('vault', 'secret/myapp/prod#DATABASE_URL');
    assert.equal(value, 'postgres://db');
    assert.equal(persisted, 'goodtoken');
    assert.equal(calls.length, 3);
    assert.ok(calls[0].url.includes('/v1/secret/data/myapp/prod'));
    assert.ok(calls[1].url.includes('/v1/auth/approle/login'));
    assert.ok(calls[2].url.includes('/v1/secret/data/myapp/prod'));
    assert.equal(calls[2].options.headers['X-Vault-Token'], 'goodtoken');
});
