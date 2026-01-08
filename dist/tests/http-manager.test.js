"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// @ts-nocheck
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
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
const createResponse = ({ status, body, contentType }) => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: createHeaders([['content-type', contentType || 'application/json']]),
    async json() {
        return typeof body === 'string' ? JSON.parse(body) : body;
    },
    async text() {
        return typeof body === 'string' ? body : JSON.stringify(body);
    },
    async arrayBuffer() {
        const raw = typeof body === 'string' ? body : JSON.stringify(body);
        return Buffer.from(raw);
    },
});
test('APIManager retries on retryable status codes', async () => {
    let calls = 0;
    const fetchStub = async () => {
        calls += 1;
        if (calls === 1) {
            return createResponse({ status: 503, body: { ok: false } });
        }
        return createResponse({ status: 200, body: { ok: true } });
    };
    const manager = new APIManager(loggerStub, securityStub, validationStub, profileServiceStub(), null, { fetch: fetchStub });
    const result = await manager.request({ method: 'GET', url: 'https://example.com' });
    assert.equal(calls, 2);
    assert.equal(result.status, 200);
    assert.equal(result.attempts, 2);
});
test('APIManager paginates using page-based pagination', async () => {
    const fetchStub = async (url) => {
        const parsed = new URL(url);
        const page = Number(parsed.searchParams.get('page') || '1');
        const body = page < 3 ? { items: [page] } : { items: [] };
        return createResponse({ status: 200, body });
    };
    const manager = new APIManager(loggerStub, securityStub, validationStub, profileServiceStub(), null, { fetch: fetchStub });
    const result = await manager.paginate({
        method: 'GET',
        url: 'https://example.com/items',
        pagination: {
            type: 'page',
            param: 'page',
            size_param: 'limit',
            size: 1,
            max_pages: 5,
            item_path: 'data.items',
        },
    });
    assert.equal(result.page_count, 3);
    assert.deepEqual(result.items, [1, 2]);
});
test('APIManager download refuses to overwrite local files by default', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sentryfrogg-download-'));
    const targetPath = path.join(dir, 'report.txt');
    await fs.writeFile(targetPath, 'old');
    const fetchStub = async () => createResponse({ status: 200, body: 'new' });
    const manager = new APIManager(loggerStub, securityStub, validationStub, profileServiceStub(), null, { fetch: fetchStub });
    await assert.rejects(() => manager.download({ method: 'GET', url: 'https://example.com/report', download_path: targetPath }), /Local path already exists/);
    const result = await manager.download({
        method: 'GET',
        url: 'https://example.com/report',
        download_path: targetPath,
        overwrite: true,
    });
    assert.equal(result.success, true);
    assert.equal(await fs.readFile(targetPath, 'utf8'), 'new');
    await fs.rm(dir, { recursive: true, force: true });
});
test('APIManager download expands ~ in download_path', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sentryfrogg-download-home-'));
    const previousHome = process.env.HOME;
    try {
        process.env.HOME = dir;
        const targetPath = path.join(dir, 'report.txt');
        await fs.writeFile(targetPath, 'old');
        const fetchStub = async () => createResponse({ status: 200, body: 'new' });
        const manager = new APIManager(loggerStub, securityStub, validationStub, profileServiceStub(), null, { fetch: fetchStub });
        await assert.rejects(() => manager.download({ method: 'GET', url: 'https://example.com/report', download_path: '~/report.txt' }), /Local path already exists/);
        const result = await manager.download({
            method: 'GET',
            url: 'https://example.com/report',
            download_path: '~/report.txt',
            overwrite: true,
        });
        assert.equal(result.success, true);
        assert.equal(result.file_path, targetPath);
        assert.equal(await fs.readFile(targetPath, 'utf8'), 'new');
    }
    finally {
        if (previousHome === undefined) {
            delete process.env.HOME;
        }
        else {
            process.env.HOME = previousHome;
        }
        await fs.rm(dir, { recursive: true, force: true });
    }
});
