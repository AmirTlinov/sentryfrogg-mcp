"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// @ts-nocheck
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const ToolError = require('../src/errors/ToolError');
const { resolveSandboxPath } = require('../src/utils/sandbox');
const { resolveArtifactPath } = require('../src/utils/artifacts');
const { getPathValue } = require('../src/utils/dataPath');
const { parseRunbookDsl } = require('../src/utils/runbookDsl');
const { quoteQualifiedIdentifier } = require('../src/utils/sql');
async function makeTempDir(prefix) {
    return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}
test('utils: sandbox traversal returns ToolError.denied', async () => {
    const root = await makeTempDir('sf-toolerror-sandbox-');
    await assert.rejects(() => resolveSandboxPath(root, '../outside.txt'), (error) => ToolError.isToolError(error) && error.kind === 'denied' && error.code === 'PATH_ESCAPES_SANDBOX');
});
test('utils: artifacts path escape returns ToolError.denied', async (t) => {
    const root = await makeTempDir('sf-toolerror-artifacts-');
    t.after(async () => {
        await fs.rm(root, { recursive: true, force: true });
    });
    assert.throws(() => resolveArtifactPath(root, '../evil.txt'), (error) => ToolError.isToolError(error) && error.kind === 'denied' && error.code === 'ARTIFACT_PATH_ESCAPES_ROOT');
});
test('utils: dataPath required missing returns ToolError.invalidParams', () => {
    assert.throws(() => getPathValue({ ok: true }, 'missing.path', { required: true }), (error) => ToolError.isToolError(error) && error.kind === 'invalid_params' && /not found/i.test(error.message));
});
test('utils: runbookDsl parse errors return ToolError.invalidParams', () => {
    assert.throws(() => parseRunbookDsl('wat something'), (error) => ToolError.isToolError(error) && error.kind === 'invalid_params');
});
test('utils: sql identifier validation returns ToolError.invalidParams', () => {
    assert.throws(() => quoteQualifiedIdentifier(''), (error) => ToolError.isToolError(error) && error.kind === 'invalid_params');
});
