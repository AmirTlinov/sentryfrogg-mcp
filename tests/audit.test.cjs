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
