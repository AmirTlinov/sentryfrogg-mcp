// @ts-nocheck
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const ToolExecutor = require('../src/services/ToolExecutor');

const loggerStub = {
  child() {
    return this;
  },
  info() {},
  warn() {},
  error() {},
};

const stateStub = {
  async set() {},
};

test('ToolExecutor spills large strings into artifact placeholders', async (t) => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-spill-'));
  const prevRoot = process.env.SF_CONTEXT_REPO_ROOT;
  const prevInline = process.env.SF_MAX_INLINE_BYTES;
  const prevCapture = process.env.SF_MAX_CAPTURE_BYTES;
  const prevMaxSpills = process.env.SF_MAX_SPILLS;

  process.env.SF_CONTEXT_REPO_ROOT = tmpRoot;
  process.env.SF_MAX_INLINE_BYTES = '128';
  process.env.SF_MAX_CAPTURE_BYTES = '1024';
  process.env.SF_MAX_SPILLS = '5';

  t.after(async () => {
    if (prevRoot === undefined) {
      delete process.env.SF_CONTEXT_REPO_ROOT;
    } else {
      process.env.SF_CONTEXT_REPO_ROOT = prevRoot;
    }
    if (prevInline === undefined) {
      delete process.env.SF_MAX_INLINE_BYTES;
    } else {
      process.env.SF_MAX_INLINE_BYTES = prevInline;
    }
    if (prevCapture === undefined) {
      delete process.env.SF_MAX_CAPTURE_BYTES;
    } else {
      process.env.SF_MAX_CAPTURE_BYTES = prevCapture;
    }
    if (prevMaxSpills === undefined) {
      delete process.env.SF_MAX_SPILLS;
    } else {
      process.env.SF_MAX_SPILLS = prevMaxSpills;
    }
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  const executor = new ToolExecutor(loggerStub, stateStub, null, null, null, {});
  const traceId = 'trace-1';
  const spanId = 'span-1';
  const payload = await executor.wrapResult({
    tool: 'mcp_test',
    args: { trace_id: traceId, span_id: spanId },
    result: { big: 'a'.repeat(10_000) },
    startedAt: Date.now(),
    traceId,
    spanId,
  });

  assert.equal(payload.ok, true);
  assert.equal(payload.result.big.truncated, true);
  assert.ok(payload.result.big.bytes > 1024);
  assert.ok(payload.result.big.sha256);
  assert.ok(payload.result.big.preview);
  assert.ok(payload.result.big.artifact);
  assert.ok(payload.result.big.artifact.uri.startsWith('artifact://runs/trace-1/tool_calls/span-1/'));

  const rel = payload.result.big.artifact.rel;
  const artifactPath = path.join(tmpRoot, 'artifacts', rel);
  const written = await fs.readFile(artifactPath, 'utf8');
  assert.ok(Buffer.byteLength(written, 'utf8') <= 1024);
});

test('ToolExecutor does not spill sensitive keys to artifacts', async (t) => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-spill-sensitive-'));
  const prevRoot = process.env.SF_CONTEXT_REPO_ROOT;
  const prevInline = process.env.SF_MAX_INLINE_BYTES;
  const prevCapture = process.env.SF_MAX_CAPTURE_BYTES;

  process.env.SF_CONTEXT_REPO_ROOT = tmpRoot;
  process.env.SF_MAX_INLINE_BYTES = '64';
  process.env.SF_MAX_CAPTURE_BYTES = '256';

  t.after(async () => {
    if (prevRoot === undefined) {
      delete process.env.SF_CONTEXT_REPO_ROOT;
    } else {
      process.env.SF_CONTEXT_REPO_ROOT = prevRoot;
    }
    if (prevInline === undefined) {
      delete process.env.SF_MAX_INLINE_BYTES;
    } else {
      process.env.SF_MAX_INLINE_BYTES = prevInline;
    }
    if (prevCapture === undefined) {
      delete process.env.SF_MAX_CAPTURE_BYTES;
    } else {
      process.env.SF_MAX_CAPTURE_BYTES = prevCapture;
    }
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  const executor = new ToolExecutor(loggerStub, stateStub, null, null, null, {});
  const payload = await executor.wrapResult({
    tool: 'mcp_test',
    args: { trace_id: 'trace-2', span_id: 'span-2' },
    result: { token: 'a'.repeat(10_000) },
    startedAt: Date.now(),
    traceId: 'trace-2',
    spanId: 'span-2',
  });

  assert.equal(payload.ok, true);
  assert.equal(payload.result.token.truncated, true);
  assert.equal(payload.result.token.artifact, null);
});

test('ToolExecutor reuses existing *_ref for *_buffer spill placeholders', async (t) => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-spill-buffer-'));
  const prevRoot = process.env.SF_CONTEXT_REPO_ROOT;
  const prevInline = process.env.SF_MAX_INLINE_BYTES;
  const prevCapture = process.env.SF_MAX_CAPTURE_BYTES;

  process.env.SF_CONTEXT_REPO_ROOT = tmpRoot;
  process.env.SF_MAX_INLINE_BYTES = '64';
  process.env.SF_MAX_CAPTURE_BYTES = '256';

  t.after(async () => {
    if (prevRoot === undefined) {
      delete process.env.SF_CONTEXT_REPO_ROOT;
    } else {
      process.env.SF_CONTEXT_REPO_ROOT = prevRoot;
    }
    if (prevInline === undefined) {
      delete process.env.SF_MAX_INLINE_BYTES;
    } else {
      process.env.SF_MAX_INLINE_BYTES = prevInline;
    }
    if (prevCapture === undefined) {
      delete process.env.SF_MAX_CAPTURE_BYTES;
    } else {
      process.env.SF_MAX_CAPTURE_BYTES = prevCapture;
    }
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  const executor = new ToolExecutor(loggerStub, stateStub, null, null, null, {});
  const existing = {
    uri: 'artifact://runs/trace-3/tool_calls/span-3/stdout.log',
    rel: 'runs/trace-3/tool_calls/span-3/stdout.log',
    bytes: 123,
    truncated: false,
  };

  const payload = await executor.wrapResult({
    tool: 'mcp_test',
    args: { trace_id: 'trace-3', span_id: 'span-3' },
    result: { stdout_buffer: Buffer.alloc(10_000, 1), stdout_ref: existing },
    startedAt: Date.now(),
    traceId: 'trace-3',
    spanId: 'span-3',
  });

  assert.equal(payload.result.stdout_buffer.truncated, true);
  assert.equal(payload.result.stdout_buffer.artifact.uri, existing.uri);
});
