const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
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

function sha256FingerprintFromBlobBase64(blob) {
  const bytes = Buffer.from(blob, 'base64');
  const hash = crypto.createHash('sha256').update(bytes).digest('base64').replace(/=+$/, '');
  return `SHA256:${hash}`;
}

test('authorized_keys_add reads .pub file and sends it via stdin', async () => {
  const manager = new SSHManager(loggerStub, securityStub, validationStub, profileServiceStub());

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sentryfrogg-ssh-pub-'));
  const pubPath = path.join(tmpDir, 'id_test.pub');
  const blob = 'dGVzdA==';
  const keyLine = `ssh-ed25519 ${blob} test@example\n`;
  await fs.writeFile(pubPath, keyLine, 'utf8');

  let captured = null;
  manager.execCommand = async (args) => {
    captured = args;
    return { stdout: 'added', stderr: '', exitCode: 0 };
  };

  const result = await manager.handleAction({
    action: 'authorized_keys_add',
    profile_name: 'default',
    public_key_path: pubPath,
    authorized_keys_path: '/tmp/authorized_keys',
  });

  assert.equal(result.success, true);
  assert.equal(result.changed, true);
  assert.equal(result.key_type, 'ssh-ed25519');
  assert.equal(result.key_fingerprint_sha256, sha256FingerprintFromBlobBase64(blob));

  assert.ok(captured);
  assert.equal(captured.pty, false);
  assert.ok(String(captured.stdin).includes(`ssh-ed25519 ${blob}`));
  assert.ok(String(captured.command).includes('authorized_keys'));
  assert.equal(captured.env.AUTH_KEYS_PATH, '/tmp/authorized_keys');
  assert.ok(!String(captured.command).includes(blob));
});

test('authorized_keys_add expands ~ in public_key_path', async () => {
  const manager = new SSHManager(loggerStub, securityStub, validationStub, profileServiceStub());

  const previousHome = process.env.HOME;
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sentryfrogg-ssh-home-'));
  try {
    process.env.HOME = tmpDir;

    const pubPath = path.join(tmpDir, 'id_test.pub');
    const blob = 'dGVzdA==';
    const keyLine = `ssh-ed25519 ${blob} test@example\n`;
    await fs.writeFile(pubPath, keyLine, 'utf8');

    let captured = null;
    manager.execCommand = async (args) => {
      captured = args;
      return { stdout: 'added', stderr: '', exitCode: 0 };
    };

    const result = await manager.handleAction({
      action: 'authorized_keys_add',
      profile_name: 'default',
      public_key_path: '~/id_test.pub',
    });

    assert.equal(result.success, true);
    assert.ok(captured);
    assert.ok(String(captured.stdin).includes(`ssh-ed25519 ${blob}`));
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
});

test('authorized_keys_add returns changed=false when key already present', async () => {
  const manager = new SSHManager(loggerStub, securityStub, validationStub, profileServiceStub());
  manager.execCommand = async () => ({ stdout: 'present', stderr: '', exitCode: 0 });

  const result = await manager.handleAction({
    action: 'authorized_keys_add',
    profile_name: 'default',
    public_key: 'ssh-ed25519 dGVzdA== test@example',
  });

  assert.equal(result.success, true);
  assert.equal(result.changed, false);
});

test('authorized_keys_add rejects invalid key format', async () => {
  const manager = new SSHManager(loggerStub, securityStub, validationStub, profileServiceStub());

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sentryfrogg-ssh-pub-'));
  const pubPath = path.join(tmpDir, 'bad.pub');
  await fs.writeFile(pubPath, 'not-a-key\n', 'utf8');

  await assert.rejects(
    () => manager.handleAction({ action: 'authorized_keys_add', public_key_path: pubPath, profile_name: 'default' }),
    /invalid format/
  );
});

test('authorized_keys_add rejects multi-line key input', async () => {
  const manager = new SSHManager(loggerStub, securityStub, validationStub, profileServiceStub());

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sentryfrogg-ssh-pub-'));
  const pubPath = path.join(tmpDir, 'multi.pub');
  await fs.writeFile(pubPath, 'ssh-ed25519 dGVzdA== one\nssh-ed25519 dGVzdA== two\n', 'utf8');

  await assert.rejects(
    () => manager.handleAction({ action: 'authorized_keys_add', public_key_path: pubPath, profile_name: 'default' }),
    /single key line/
  );
});

test('authorized_keys_add requires public_key or public_key_path', async () => {
  const manager = new SSHManager(loggerStub, securityStub, validationStub, profileServiceStub());

  await assert.rejects(
    () => manager.handleAction({ action: 'authorized_keys_add', profile_name: 'default' }),
    /public_key or public_key_path is required/
  );
});
