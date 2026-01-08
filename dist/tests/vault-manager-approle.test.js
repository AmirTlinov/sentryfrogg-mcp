"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// @ts-nocheck
const test = require('node:test');
const assert = require('node:assert/strict');
const VaultManager = require('../src/managers/VaultManager');
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
test('VaultManager profile_upsert stores AppRole creds and skips token lookup', async () => {
    const calls = { setProfile: [], deleteProfile: 0, sysHealth: 0, tokenLookup: 0 };
    const profileServiceStub = {
        async getProfile() {
            const error = new Error('Profile not found');
            error.code = 'NOT_FOUND';
            throw error;
        },
        async setProfile(name, config) {
            calls.setProfile.push({ name, config });
        },
        async deleteProfile() {
            calls.deleteProfile += 1;
        },
    };
    const vaultClientStub = {
        async sysHealth() {
            calls.sysHealth += 1;
            return { initialized: true, sealed: false };
        },
        async tokenLookupSelf() {
            calls.tokenLookup += 1;
            return { data: { ttl: 1000 } };
        },
    };
    const manager = new VaultManager(loggerStub, validationStub, profileServiceStub, vaultClientStub);
    const result = await manager.handleAction({
        action: 'profile_upsert',
        profile_name: 'vault-prod',
        addr: 'https://vault.example',
        auth_type: 'approle',
        role_id: 'role-1',
        secret_id: 'secret-1',
        token: null,
    });
    assert.equal(result.success, true);
    assert.equal(result.profile.auth, 'approle');
    assert.equal(calls.sysHealth, 1);
    assert.equal(calls.tokenLookup, 0);
    assert.equal(calls.deleteProfile, 0);
    assert.equal(calls.setProfile.length, 1);
    assert.equal(calls.setProfile[0].name, 'vault-prod');
    assert.equal(calls.setProfile[0].config.type, 'vault');
    assert.equal(calls.setProfile[0].config.data.auth_type, 'approle');
    assert.deepEqual(calls.setProfile[0].config.secrets, {
        token: null,
        role_id: 'role-1',
        secret_id: 'secret-1',
    });
});
test('VaultManager profile_upsert infers approle auth_type', async () => {
    const calls = { setProfile: [] };
    const profileServiceStub = {
        async getProfile() {
            throw new Error('not found');
        },
        async setProfile(name, config) {
            calls.setProfile.push({ name, config });
        },
        async deleteProfile() { },
    };
    const vaultClientStub = {
        async sysHealth() {
            return { initialized: true };
        },
        async tokenLookupSelf() {
            throw new Error('should not be called');
        },
    };
    const manager = new VaultManager(loggerStub, validationStub, profileServiceStub, vaultClientStub);
    const result = await manager.handleAction({
        action: 'profile_upsert',
        profile_name: 'vault-prod',
        addr: 'https://vault.example',
        role_id: 'role-1',
        secret_id: 'secret-1',
    });
    assert.equal(result.success, true);
    assert.equal(result.profile.auth, 'approle');
    assert.equal(calls.setProfile[0].config.data.auth_type, 'approle');
});
test('VaultManager profile_upsert rejects token auth without token', async () => {
    const manager = new VaultManager(loggerStub, validationStub, {
        async getProfile() {
            throw new Error('not found');
        },
        async setProfile() { },
        async deleteProfile() { },
    }, {
        async sysHealth() { },
        async tokenLookupSelf() { },
    });
    await assert.rejects(() => manager.handleAction({
        action: 'profile_upsert',
        profile_name: 'vault-prod',
        addr: 'https://vault.example',
        auth_type: 'token',
        token: null,
    }), /token is required/i);
});
