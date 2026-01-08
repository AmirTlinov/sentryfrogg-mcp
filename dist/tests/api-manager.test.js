"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// @ts-nocheck
const test = require('node:test');
const assert = require('node:assert/strict');
const APIManager = require('../src/managers/APIManager');
const loggerStub = {
    child() {
        return this;
    },
    error() { },
    warn() { },
    info() { },
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
const profileServiceStub = () => ({
    async getProfile() {
        return { data: {}, secrets: {} };
    },
    async listProfiles() {
        return [];
    },
    async setProfile() { },
    async deleteProfile() { },
});
const createHeaders = (items) => ({
    get(key) {
        const found = items.find(([name]) => name.toLowerCase() === key.toLowerCase());
        return found ? found[1] : undefined;
    },
    entries() {
        return items[Symbol.iterator]();
    },
});
test('APIManager preserves string payloads without double encoding', async () => {
    let captured;
    const fetchStub = async (url, options) => {
        captured = { url, options };
        return {
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: createHeaders([['content-type', 'text/plain']]),
            text: async () => 'pong',
        };
    };
    const manager = new APIManager(loggerStub, securityStub, validationStub, profileServiceStub(), null, { fetch: fetchStub });
    const result = await manager.request({ method: 'POST', url: 'https://example.com', body: 'ping' });
    assert.equal(captured.options.body, 'ping');
    assert.equal(captured.options.headers['Content-Type'], 'text/plain; charset=utf-8');
    assert.equal(result.data, 'pong');
});
test('APIManager respects custom headers and sets bearer auth', async () => {
    let capturedHeaders;
    const fetchStub = async (_url, options) => {
        capturedHeaders = options.headers;
        return {
            ok: true,
            status: 201,
            statusText: 'Created',
            headers: createHeaders([['content-type', 'application/json']]),
            json: async () => ({ echoed: options.body }),
        };
    };
    const manager = new APIManager(loggerStub, securityStub, validationStub, profileServiceStub(), null, { fetch: fetchStub });
    const result = await manager.request({
        method: 'PUT',
        url: 'https://example.com',
        body: { status: 'ok' },
        headers: { 'Content-Type': 'application/vnd.custom+json' },
        auth: { type: 'bearer', token: 'secret' },
    });
    assert.equal(result.status, 201);
    assert.equal(result.data.echoed, JSON.stringify({ status: 'ok' }));
    assert.equal(capturedHeaders['Content-Type'], 'application/vnd.custom+json');
    assert.equal(capturedHeaders.Authorization, 'Bearer secret');
});
