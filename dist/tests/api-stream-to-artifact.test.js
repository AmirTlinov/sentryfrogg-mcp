"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// @ts-nocheck
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
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
function restoreEnv(key, previous) {
    if (previous === undefined) {
        delete process.env[key];
    }
    else {
        process.env[key] = previous;
    }
}
test('APIManager stream-to-artifact=full stores full body while returning preview', async (t) => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sentryfrogg-api-stream-'));
    t.after(async () => {
        await fs.rm(tmpRoot, { recursive: true, force: true });
    });
    const prevContext = process.env.SF_CONTEXT_REPO_ROOT;
    const prevStream = process.env.SF_API_STREAM_TO_ARTIFACT;
    const prevMaxCapture = process.env.SF_API_MAX_CAPTURE_BYTES;
    try {
        process.env.SF_CONTEXT_REPO_ROOT = tmpRoot;
        process.env.SF_API_STREAM_TO_ARTIFACT = 'full';
        process.env.SF_API_MAX_CAPTURE_BYTES = '4';
        const fetchStub = async () => ({
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: createHeaders([['content-type', 'text/plain']]),
            body: Readable.from([Buffer.from('hello\n')]),
        });
        const manager = new APIManager(loggerStub, securityStub, validationStub, profileServiceStub(), null, { fetch: fetchStub });
        const result = await manager.request({
            method: 'GET',
            url: 'https://example.com',
            response_type: 'text',
            trace_id: 'trace-1',
            span_id: 'span-1',
        });
        assert.equal(result.data, 'hell');
        assert.equal(result.data_truncated, true);
        assert.equal(result.body_truncated, true);
        assert.ok(result.body_ref);
        assert.equal(result.body_ref_truncated, false);
        const bodyPath = path.join(tmpRoot, 'artifacts', result.body_ref.rel);
        assert.equal(await fs.readFile(bodyPath, 'utf8'), 'hello\n');
    }
    finally {
        restoreEnv('SF_CONTEXT_REPO_ROOT', prevContext);
        restoreEnv('SF_API_STREAM_TO_ARTIFACT', prevStream);
        restoreEnv('SF_API_MAX_CAPTURE_BYTES', prevMaxCapture);
    }
});
