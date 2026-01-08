// @ts-nocheck
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const SSHManager = require('../src/managers/SSHManager');

const loggerStub = {
  child() {
    return this;
  },
  info() {},
  warn() {},
  error() {},
};

const validationStub = {
  ensurePort(value, fallback) {
    return value ?? fallback;
  },
  ensureString(value) {
    return String(value);
  },
};

const securityStub = {
  cleanCommand(value) {
    return value;
  },
};

function restoreEnv(key, previous) {
  if (previous === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = previous;
  }
}

test('SSHManager stream-to-artifact (capped) writes stdout/stderr artifacts', async (t) => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sentryfrogg-ssh-stream-'));
  t.after(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  const prevContext = process.env.SF_CONTEXT_REPO_ROOT;
  const prevStream = process.env.SF_SSH_STREAM_TO_ARTIFACT;
  const prevMaxCapture = process.env.SF_SSH_MAX_CAPTURE_BYTES;
  const prevMaxInline = process.env.SF_SSH_MAX_INLINE_BYTES;

  try {
    process.env.SF_CONTEXT_REPO_ROOT = tmpRoot;
    process.env.SF_SSH_STREAM_TO_ARTIFACT = 'true';
    process.env.SF_SSH_MAX_CAPTURE_BYTES = '4';
    process.env.SF_SSH_MAX_INLINE_BYTES = '4';

    const manager = new SSHManager(loggerStub, securityStub, validationStub, null, null, null);

    const stream = new EventEmitter();
    stream.stderr = new EventEmitter();
    stream.close = () => {};
    stream.destroy = () => {};

    const client = {
      exec(_command, _options, cb) {
        cb(null, stream);
        process.nextTick(() => {
          stream.emit('data', Buffer.from('hello\n'));
          stream.stderr.emit('data', Buffer.from('oops\n'));
          stream.emit('close', 0, null);
        });
      },
      destroy() {},
    };

    const result = await manager.exec(client, 'echo hi', {}, { trace_id: 'trace-1', span_id: 'span-1' });

    assert.equal(result.stdout, 'hell');
    assert.equal(result.stderr, 'oops');
    assert.equal(result.stdout_truncated, true);
    assert.equal(result.stderr_truncated, true);
    assert.equal(result.stdout_inline_truncated, true);
    assert.equal(result.stderr_inline_truncated, true);
    assert.ok(result.stdout_ref);
    assert.ok(result.stderr_ref);

    const stdoutPath = path.join(tmpRoot, 'artifacts', result.stdout_ref.rel);
    const stderrPath = path.join(tmpRoot, 'artifacts', result.stderr_ref.rel);
    assert.equal(await fs.readFile(stdoutPath, 'utf8'), 'hell');
    assert.equal(await fs.readFile(stderrPath, 'utf8'), 'oops');
  } finally {
    restoreEnv('SF_CONTEXT_REPO_ROOT', prevContext);
    restoreEnv('SF_SSH_STREAM_TO_ARTIFACT', prevStream);
    restoreEnv('SF_SSH_MAX_CAPTURE_BYTES', prevMaxCapture);
    restoreEnv('SF_SSH_MAX_INLINE_BYTES', prevMaxInline);
  }
});

test('SSHManager stream-to-artifact=full captures beyond max_capture_bytes', async (t) => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sentryfrogg-ssh-stream-full-'));
  t.after(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  const prevContext = process.env.SF_CONTEXT_REPO_ROOT;
  const prevStream = process.env.SF_SSH_STREAM_TO_ARTIFACT;
  const prevMaxCapture = process.env.SF_SSH_MAX_CAPTURE_BYTES;
  const prevMaxInline = process.env.SF_SSH_MAX_INLINE_BYTES;

  try {
    process.env.SF_CONTEXT_REPO_ROOT = tmpRoot;
    process.env.SF_SSH_STREAM_TO_ARTIFACT = 'full';
    process.env.SF_SSH_MAX_CAPTURE_BYTES = '4';
    process.env.SF_SSH_MAX_INLINE_BYTES = '4';

    const manager = new SSHManager(loggerStub, securityStub, validationStub, null, null, null);

    const stream = new EventEmitter();
    stream.stderr = new EventEmitter();
    stream.close = () => {};
    stream.destroy = () => {};

    const client = {
      exec(_command, _options, cb) {
        cb(null, stream);
        process.nextTick(() => {
          stream.emit('data', Buffer.from('hello\n'));
          stream.emit('close', 0, null);
        });
      },
      destroy() {},
    };

    const result = await manager.exec(client, 'echo hi', {}, { trace_id: 'trace-1', span_id: 'span-1' });

    assert.equal(result.stdout, 'hell');
    assert.equal(result.stdout_truncated, false);
    assert.equal(result.stdout_captured_bytes, 6);
    assert.ok(result.stdout_ref);

    const stdoutPath = path.join(tmpRoot, 'artifacts', result.stdout_ref.rel);
    assert.equal(await fs.readFile(stdoutPath, 'utf8'), 'hello\n');
  } finally {
    restoreEnv('SF_CONTEXT_REPO_ROOT', prevContext);
    restoreEnv('SF_SSH_STREAM_TO_ARTIFACT', prevStream);
    restoreEnv('SF_SSH_MAX_CAPTURE_BYTES', prevMaxCapture);
    restoreEnv('SF_SSH_MAX_INLINE_BYTES', prevMaxInline);
  }
});
