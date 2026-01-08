// @ts-nocheck
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const ArtifactManager = require('../src/managers/ArtifactManager');
const ToolError = require('../src/errors/ToolError');

const loggerStub = {
  child() {
    return this;
  },
  info() {},
  warn() {},
  error() {},
};

test('ArtifactManager list/get/head/tail work with bounded reads', async (t) => {
  const contextRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-artifacts-'));
  const prevRoot = process.env.SF_CONTEXT_REPO_ROOT;
  process.env.SF_CONTEXT_REPO_ROOT = contextRoot;

  t.after(async () => {
    if (prevRoot === undefined) {
      delete process.env.SF_CONTEXT_REPO_ROOT;
    } else {
      process.env.SF_CONTEXT_REPO_ROOT = prevRoot;
    }
    await fs.rm(contextRoot, { recursive: true, force: true });
  });

  const manager = new ArtifactManager(loggerStub, {});
  const prefix = `test-artifact-manager/${crypto.randomUUID()}`;
  const rel = `${prefix}/sample.txt`;
  const filePath = path.join(contextRoot, 'artifacts', rel);

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const content = 'hello world\nsecond line\nthird line\n';
  await fs.writeFile(filePath, content, 'utf8');

  const listed = await manager.handleAction({ action: 'list', prefix, limit: 50 });
  assert.equal(listed.success, true);
  assert.ok(listed.items.some((item) => item.rel === rel));

  const head = await manager.handleAction({ action: 'head', rel, max_bytes: 5 });
  assert.equal(head.success, true);
  assert.equal(head.content, 'hello');
  assert.equal(head.truncated, true);

  const tail = await manager.handleAction({ action: 'tail', rel, max_bytes: 5 });
  assert.equal(tail.success, true);
  assert.equal(tail.content, 'line\n');
  assert.equal(tail.truncated, true);

  const slice = await manager.handleAction({ action: 'get', rel, offset: 6, max_bytes: 5 });
  assert.equal(slice.success, true);
  assert.equal(slice.content, 'world');
  assert.equal(slice.truncated, true);

  await assert.rejects(
    () => manager.handleAction({ action: 'get', rel: `${prefix}/missing.txt` }),
    (error) => ToolError.isToolError(error) && error.kind === 'not_found'
  );
});
