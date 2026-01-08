"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// @ts-nocheck
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { buildToolCallContextRef, buildToolCallFileRef, resolveArtifactPath, writeTextArtifact, writeBinaryArtifact, } = require('../src/utils/artifacts');
const loggerStub = {
    child() {
        return this;
    },
    info() { },
    warn() { },
    error() { },
};
test('artifacts writes tool call context and files under contextRoot/artifacts', async (t) => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sentryfrogg-artifacts-'));
    t.after(async () => {
        await fs.rm(tmpRoot, { recursive: true, force: true });
    });
    const ctxRef = buildToolCallContextRef({ traceId: 'trace-1', spanId: 'span-1' });
    assert.equal(ctxRef.uri, 'artifact://runs/trace-1/tool_calls/span-1.context');
    const ctxWrite = await writeTextArtifact(tmpRoot, ctxRef, 'hello\n');
    assert.equal(ctxWrite.uri, ctxRef.uri);
    assert.ok(ctxWrite.path.endsWith(path.join('artifacts', 'runs', 'trace-1', 'tool_calls', 'span-1.context')));
    assert.equal(await fs.readFile(ctxWrite.path, 'utf8'), 'hello\n');
    const fileRef = buildToolCallFileRef({ traceId: 'trace-1', spanId: 'span-1', filename: 'diff.patch' });
    assert.equal(fileRef.uri, 'artifact://runs/trace-1/tool_calls/span-1/diff.patch');
    const fileWrite = await writeBinaryArtifact(tmpRoot, fileRef, Buffer.from('patch\n'));
    assert.equal(await fs.readFile(fileWrite.path, 'utf8'), 'patch\n');
    const resolved = resolveArtifactPath(tmpRoot, 'runs/trace-1/tool_calls/span-1/diff.patch');
    assert.equal(resolved, fileWrite.path);
});
test('artifacts rejects traversal in segments/filenames', async () => {
    assert.throws(() => buildToolCallFileRef({ traceId: '..', spanId: 'x', filename: 'a.txt' }));
    assert.throws(() => buildToolCallFileRef({ traceId: 'x', spanId: '../y', filename: 'a.txt' }));
    assert.throws(() => buildToolCallFileRef({ traceId: 'x', spanId: 'y', filename: '../a.txt' }));
    assert.throws(() => buildToolCallFileRef({ traceId: 'x', spanId: 'y', filename: 'a/b.txt' }));
    assert.throws(() => buildToolCallFileRef({ traceId: 'x', spanId: 'y', filename: 'a\\b.txt' }));
});
test('artifacts rejects resolved path escapes', async (t) => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sentryfrogg-artifacts-'));
    t.after(async () => {
        await fs.rm(tmpRoot, { recursive: true, force: true });
    });
    assert.throws(() => resolveArtifactPath(tmpRoot, '../evil.txt'));
});
