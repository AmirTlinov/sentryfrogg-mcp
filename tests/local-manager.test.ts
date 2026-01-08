// @ts-nocheck
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const LocalManager = require('../src/managers/LocalManager');
const Validation = require('../src/services/Validation');

const loggerStub = {
  child() {
    return this;
  },
  warn() {},
  info() {},
  error() {},
};

function createLocalManager({ enabled }) {
  const validation = new Validation(loggerStub);
  return new LocalManager(loggerStub, validation, { enabled });
}

test('LocalManager rejects when unsafe mode is disabled', async () => {
  const manager = createLocalManager({ enabled: false });
  await assert.rejects(
    () => manager.handleAction({ action: 'exec', command: 'noop' }),
    /Unsafe local tool is disabled/
  );
});

test('LocalManager executes a local command (file-first, inline optional)', async () => {
  const manager = createLocalManager({ enabled: true });

  const result = await manager.handleAction({
    action: 'exec',
    command: process.execPath,
    args: ['-e', 'process.stdout.write("hello")'],
    inline: true,
  });

  assert.equal(result.exit_code, 0);
  assert.equal(result.stdout, 'hello');
  assert.ok(result.stdout_path);

  const fromFile = await fs.readFile(result.stdout_path, 'utf8');
  assert.equal(fromFile, 'hello');
});

test('LocalManager fs_write refuses overwrite unless overwrite=true', async () => {
  const manager = createLocalManager({ enabled: true });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sentryfrogg-local-fs-'));
  const filePath = path.join(dir, 'note.txt');

  try {
    await manager.handleAction({ action: 'fs_write', path: filePath, content: 'one' });
    const read1 = await manager.handleAction({ action: 'fs_read', path: filePath });
    assert.equal(read1.content, 'one');

    await assert.rejects(
      () => manager.handleAction({ action: 'fs_write', path: filePath, content: 'two' }),
      /already exists/
    );

    await manager.handleAction({ action: 'fs_write', path: filePath, content: 'two', overwrite: true });
    const read2 = await manager.handleAction({ action: 'fs_read', path: filePath });
    assert.equal(read2.content, 'two');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('LocalManager fs_* expands ~ in path', async () => {
  const manager = createLocalManager({ enabled: true });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sentryfrogg-local-home-'));
  const previousHome = process.env.HOME;
  try {
    process.env.HOME = dir;
    const expandedPath = path.join(dir, 'note.txt');

    await manager.handleAction({ action: 'fs_write', path: '~/note.txt', content: 'one' });
    const read = await manager.handleAction({ action: 'fs_read', path: '~/note.txt' });
    assert.equal(read.path, expandedPath);
    assert.equal(read.content, 'one');

    const stat = await manager.handleAction({ action: 'fs_stat', path: '~/note.txt' });
    assert.equal(stat.path, expandedPath);
    assert.equal(stat.type, 'file');
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
});
