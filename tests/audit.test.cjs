const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const AuditService = require('../src/services/AuditService.cjs');
const ToolExecutor = require('../src/services/ToolExecutor.cjs');

const loggerStub = {
  child() {
    return this;
  },
  warn() {},
  info() {},
  error() {},
};

function createTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'sentryfrogg-audit-'));
}

test('Audit log redacts sensitive fields', async () => {
  const dir = await createTempDir();
  const auditPath = path.join(dir, 'audit.jsonl');
  const original = process.env.MCP_AUDIT_PATH;
  process.env.MCP_AUDIT_PATH = auditPath;

  const auditService = new AuditService(loggerStub);

  const stateService = {
    async set() {},
  };

  const executor = new ToolExecutor(
    loggerStub,
    stateService,
    null,
    null,
    auditService,
    {
      mcp_api_client: async (args) => ({ ok: true, args }),
    }
  );

  await executor.execute('mcp_api_client', {
    action: 'request',
    auth_token: 'secret-token',
    headers: { Authorization: 'Bearer secret-token' },
    body_base64: Buffer.from('payload').toString('base64'),
  });

  const raw = await fs.readFile(auditPath, 'utf8');
  const entry = JSON.parse(raw.trim().split(/\r?\n/)[0]);

  assert.equal(entry.input.auth_token, '[REDACTED]');
  assert.equal(entry.input.headers.Authorization, '[REDACTED]');
  assert.ok(entry.input.body_base64.startsWith('[base64:'));

  process.env.MCP_AUDIT_PATH = original;
  await fs.rm(dir, { recursive: true, force: true });
});

test('Audit log redacts env maps and summaries stdin/content payloads', async () => {
  const dir = await createTempDir();
  const auditPath = path.join(dir, 'audit.jsonl');
  const original = process.env.MCP_AUDIT_PATH;
  process.env.MCP_AUDIT_PATH = auditPath;

  const auditService = new AuditService(loggerStub);
  const stateService = {
    async set() {},
  };

  const executor = new ToolExecutor(
    loggerStub,
    stateService,
    null,
    null,
    auditService,
    {
      mcp_ssh_manager: async (args) => ({ ok: true, args }),
      mcp_local: async (args) => ({ ok: true, args }),
    }
  );

  await executor.execute('mcp_ssh_manager', {
    action: 'exec',
    command: 'echo ok',
    env: { DATABASE_URL: 'postgres://user:pass@host/db' },
  });

  await executor.execute('mcp_local', {
    action: 'fs_write',
    path: '/tmp/.env',
    content: 'SECRET=top-secret',
    patch: 'diff --git a/a b/a\n+token: 123\n',
    stdin: 'top-secret',
    content_base64: Buffer.from('top-secret').toString('base64'),
  });

  const raw = await fs.readFile(auditPath, 'utf8');
  const entries = raw.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.equal(entries.length, 2);

  assert.equal(entries[0].input.env.DATABASE_URL, '[REDACTED]');
  assert.ok(String(entries[1].input.content).startsWith('[content:'));
  assert.ok(String(entries[1].input.patch).startsWith('[patch:'));
  assert.ok(String(entries[1].input.stdin).startsWith('[stdin:'));
  assert.ok(String(entries[1].input.content_base64).startsWith('[base64:'));

  process.env.MCP_AUDIT_PATH = original;
  await fs.rm(dir, { recursive: true, force: true });
});

test('AuditService streams entries with reverse/offset/filters', async () => {
  const dir = await createTempDir();
  const auditPath = path.join(dir, 'audit.jsonl');
  const original = process.env.MCP_AUDIT_PATH;
  process.env.MCP_AUDIT_PATH = auditPath;

  const auditService = new AuditService(loggerStub);

  await auditService.append({
    timestamp: '2025-01-01T00:00:00.000Z',
    status: 'ok',
    tool: 'mcp_state',
    action: 'set',
    trace_id: 't1',
  });
  await auditService.append({
    timestamp: '2025-01-02T00:00:00.000Z',
    status: 'error',
    tool: 'mcp_api_client',
    action: 'request',
    trace_id: 't2',
  });
  await auditService.append({
    timestamp: '2025-01-03T00:00:00.000Z',
    status: 'ok',
    tool: 'mcp_api_client',
    action: 'request',
    trace_id: 't3',
  });

  await fs.appendFile(auditPath, 'not-json\n', 'utf8');

  const forward = await auditService.readEntries({ limit: 2, offset: 0 });
  assert.equal(forward.total, 3);
  assert.deepEqual(forward.entries.map((entry) => entry.trace_id), ['t1', 't2']);

  const reverse = await auditService.readEntries({ limit: 2, offset: 0, reverse: true });
  assert.equal(reverse.total, 3);
  assert.deepEqual(reverse.entries.map((entry) => entry.trace_id), ['t3', 't2']);

  const reverseOffset = await auditService.readEntries({ limit: 1, offset: 1, reverse: true });
  assert.deepEqual(reverseOffset.entries.map((entry) => entry.trace_id), ['t2']);

  const filteredTool = await auditService.readEntries({ limit: 10, offset: 0, filters: { tool: 'mcp_api_client' } });
  assert.equal(filteredTool.total, 2);

  const filteredStatus = await auditService.readEntries({ limit: 10, offset: 0, filters: { status: 'error' } });
  assert.deepEqual(filteredStatus.entries.map((entry) => entry.trace_id), ['t2']);

  const filteredSince = await auditService.readEntries({ limit: 10, offset: 0, filters: { since: '2025-01-02T12:00:00.000Z' } });
  assert.deepEqual(filteredSince.entries.map((entry) => entry.trace_id), ['t3']);

  process.env.MCP_AUDIT_PATH = original;
  await fs.rm(dir, { recursive: true, force: true });
});
