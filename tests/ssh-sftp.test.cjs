const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const SSHManager = require('../src/managers/SSHManager.cjs');

const loggerStub = {
  child() {
    return this;
  },
  error() {},
  warn() {},
  info() {},
};

const securityStub = {
  cleanCommand(value) {
    return value;
  },
};

const validationStub = {
  ensureString(value) {
    return value;
  },
  ensurePort(value) {
    return value ?? 22;
  },
};

const profileServiceStub = () => ({
  async listProfiles() {
    return [];
  },
  async getProfile() {
    return { data: {}, secrets: {} };
  },
});

test('sftpUpload rejects when overwrite is false and remote exists', async () => {
  const manager = new SSHManager(loggerStub, securityStub, validationStub, profileServiceStub());
  manager.withSftp = async (_args, handler) => handler({
    stat(_path, cb) {
      cb(null, { size: 1 });
    },
    fastPut(_local, _remote, cb) {
      cb(null);
    },
  });

  await assert.rejects(
    () => manager.sftpUpload({ local_path: '/tmp/local.txt', remote_path: '/remote.txt', overwrite: false }),
    /already exists/
  );
});

test('sftpList returns entries for remote path', async () => {
  const manager = new SSHManager(loggerStub, securityStub, validationStub, profileServiceStub());
  manager.withSftp = async (_args, handler) => handler({
    readdir(_path, cb) {
      cb(null, [
        { filename: 'file.txt', longname: '-rw', attrs: { size: 10, mode: 0o100644, mtime: 1, atime: 1, isDirectory: () => false } },
      ]);
    },
  });

  const result = await manager.sftpList({ path: '/data' });
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].path, '/data/file.txt');
  assert.equal(result.entries[0].type, 'file');
});

test('sftpDownload refuses to overwrite local file by default', async () => {
  const manager = new SSHManager(loggerStub, securityStub, validationStub, profileServiceStub());
  manager.withSftp = async (_args, handler) => handler({
    fastGet(_remote, _local, cb) {
      cb(null);
    },
    stat(_remote, cb) {
      cb(null, { atime: 1, mtime: 1 });
    },
  });

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sentryfrogg-sftp-'));
  const localPath = path.join(tmpDir, 'file.txt');
  await fs.writeFile(localPath, 'exists');

  await assert.rejects(
    () => manager.sftpDownload({ remote_path: '/remote/file.txt', local_path: localPath }),
    /already exists/
  );
});

test('sftpUpload expands ~ in local_path', async () => {
  const manager = new SSHManager(loggerStub, securityStub, validationStub, profileServiceStub());

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sentryfrogg-sftp-home-'));
  const previousHome = process.env.HOME;
  try {
    process.env.HOME = tmpDir;

    let capturedLocal = null;
    manager.withSftp = async (_args, handler) => handler({
      fastPut(local, _remote, cb) {
        capturedLocal = local;
        cb(null);
      },
    });

    await manager.sftpUpload({ local_path: '~/local.txt', remote_path: '/remote.txt', overwrite: true });
    assert.equal(capturedLocal, path.join(tmpDir, 'local.txt'));
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
});

test('sftpDownload expands ~ in local_path', async () => {
  const manager = new SSHManager(loggerStub, securityStub, validationStub, profileServiceStub());

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sentryfrogg-sftp-home-'));
  const previousHome = process.env.HOME;
  try {
    process.env.HOME = tmpDir;

    let capturedLocal = null;
    manager.withSftp = async (_args, handler) => handler({
      fastGet(_remote, local, cb) {
        capturedLocal = local;
        cb(null);
      },
    });

    await manager.sftpDownload({ remote_path: '/remote/file.txt', local_path: '~/file.txt', overwrite: true, mkdirs: true });
    assert.equal(capturedLocal, path.join(tmpDir, 'file.txt'));
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
});
