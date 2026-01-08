"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// @ts-nocheck
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const os = require('node:os');
const path = require('node:path');
const CacheService = require('../src/services/CacheService');
const loggerStub = {
    child() {
        return this;
    },
    warn() { },
    info() { },
    error() { },
};
function createTempDir() {
    return fs.mkdtemp(path.join(os.tmpdir(), 'sentryfrogg-cache-'));
}
test('CacheService stores JSON and file entries', async () => {
    const dir = await createTempDir();
    const original = process.env.MCP_CACHE_DIR;
    process.env.MCP_CACHE_DIR = dir;
    const cacheService = new CacheService(loggerStub);
    const key = cacheService.buildKey({ url: 'https://example.com', method: 'GET' });
    await cacheService.setJson(key, { ok: true }, { ttl_ms: 1000 });
    const cached = await cacheService.getJson(key, 1000);
    assert.equal(cached.value.ok, true);
    const fileKey = cacheService.buildKey({ url: 'https://example.com/file' });
    const writer = await cacheService.createFileWriter(fileKey, { ttl_ms: 1000 });
    await pipeline(Readable.from('hello'), writer.stream);
    await writer.finalize();
    const fileEntry = await cacheService.getFile(fileKey, 1000);
    const content = await fs.readFile(fileEntry.file_path, 'utf8');
    assert.equal(content, 'hello');
    process.env.MCP_CACHE_DIR = original;
    await fs.rm(dir, { recursive: true, force: true });
});
