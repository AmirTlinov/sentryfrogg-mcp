// @ts-nocheck
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const APIManager = require('../src/managers/APIManager');

const loggerStub = {
  child() {
    return this;
  },
  error() {},
  warn() {},
  info() {},
};

const securityStub = {
  ensureUrl(url) {
    return new URL(url);
  },
};

const validationStub = {
  ensureHeaders(headers) {
    return headers ?? {};
  },
  ensureString(value) {
    return String(value);
  },
};

const profileServiceStub = () => ({
  async getProfile() {
    return { data: {}, secrets: {} };
  },
  async listProfiles() {
    return [];
  },
  async setProfile() {},
  async deleteProfile() {},
});

test('api.smoke_http follows redirects and checks status', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/healthz') {
      res.statusCode = 204;
      res.end();
      return;
    }
    if (req.url === '/redir') {
      res.statusCode = 302;
      res.setHeader('Location', '/healthz');
      res.end();
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const base = `http://127.0.0.1:${addr.port}`;

  try {
    const manager = new APIManager(loggerStub, securityStub, validationStub, profileServiceStub(), null, {});
    const result = await manager.handleAction({
      action: 'smoke_http',
      url: `${base}/redir`,
      expect_code: 204,
      follow_redirects: true,
      insecure_ok: true,
      timeout_ms: 5000,
      max_bytes: 1024,
    });

    assert.equal(result.success, true);
    assert.equal(result.ok, true);
    assert.equal(result.status, 204);
    assert.equal(result.redirected, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('api.smoke_http truncates large bodies', async () => {
  const large = 'x'.repeat(10_000);
  const server = http.createServer((_req, res) => {
    res.statusCode = 200;
    res.setHeader('content-type', 'text/plain');
    res.end(large);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const base = `http://127.0.0.1:${addr.port}`;

  try {
    const manager = new APIManager(loggerStub, securityStub, validationStub, profileServiceStub(), null, {});
    const result = await manager.handleAction({
      action: 'smoke_http',
      url: `${base}/big`,
      expect_code: 200,
      follow_redirects: true,
      insecure_ok: true,
      timeout_ms: 5000,
      max_bytes: 128,
    });

    assert.equal(result.success, true);
    assert.equal(result.ok, true);
    assert.equal(result.truncated, true);
    assert.equal(result.captured_bytes, 128);
    assert.equal(result.body_preview.length > 0, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('api.smoke_http redacts secrets in body preview', async () => {
  const secret = 'hello sk-1234567890abcdef world';
  const server = http.createServer((_req, res) => {
    res.statusCode = 200;
    res.setHeader('content-type', 'text/plain');
    res.end(secret);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const base = `http://127.0.0.1:${addr.port}`;

  try {
    const manager = new APIManager(loggerStub, securityStub, validationStub, profileServiceStub(), null, {});
    const result = await manager.handleAction({
      action: 'smoke_http',
      url: `${base}/secret`,
      expect_code: 200,
      follow_redirects: true,
      insecure_ok: true,
      timeout_ms: 5000,
      max_bytes: 1024,
    });

    assert.equal(result.success, true);
    assert.equal(result.ok, true);
    assert.ok(result.body_preview.includes('sk-***REDACTED***'));
    assert.ok(!result.body_preview.includes('sk-1234567890abcdef'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
