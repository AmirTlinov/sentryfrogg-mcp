const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { resolveSandboxPath } = require('../src/utils/sandbox.cjs');

async function makeTempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test('resolveSandboxPath rejects traversal and absolute paths', async () => {
  const root = await makeTempDir('sf-sandbox-');

  await assert.rejects(() => resolveSandboxPath(root, '../outside.txt'), /escapes sandbox root/);
  await assert.rejects(() => resolveSandboxPath(root, '/etc/passwd'), /escapes sandbox root/);
});

test('resolveSandboxPath detects symlink escapes (mustExist=true)', async () => {
  const root = await makeTempDir('sf-sandbox-');
  const outside = await makeTempDir('sf-sandbox-outside-');
  const link = path.join(root, 'link');
  await fs.symlink(outside, link);

  const outsideFile = path.join(outside, 'pwn.txt');
  await fs.writeFile(outsideFile, 'nope', 'utf8');

  await assert.rejects(() => resolveSandboxPath(root, 'link/pwn.txt'), /escapes sandbox root/);
});

test('resolveSandboxPath detects symlink escapes (mustExist=false)', async () => {
  const root = await makeTempDir('sf-sandbox-');
  const outside = await makeTempDir('sf-sandbox-outside-');
  const link = path.join(root, 'link');
  await fs.symlink(outside, link);

  await assert.rejects(
    () => resolveSandboxPath(root, 'link/new.txt', { mustExist: false }),
    /escapes sandbox root/
  );
});

test('resolveSandboxPath works when rootDir itself is a symlink', async () => {
  const realRoot = await makeTempDir('sf-sandbox-realroot-');
  const rootLink = await makeTempDir('sf-sandbox-rootlink-');
  const root = path.join(rootLink, 'repo');
  await fs.symlink(realRoot, root);

  const sub = path.join(realRoot, 'dir');
  await fs.mkdir(sub);
  const file = path.join(sub, 'ok.txt');
  await fs.writeFile(file, 'ok', 'utf8');

  const resolved = await resolveSandboxPath(root, 'dir/ok.txt');
  assert.equal(resolved, file);
});
