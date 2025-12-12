const test = require('node:test');
const assert = require('node:assert/strict');
const APIManager = require('../src/managers/APIManager.cjs');

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
};

const createHeaders = (items) => ({
  get(key) {
    const found = items.find(([name]) => name.toLowerCase() === key.toLowerCase());
    return found ? found[1] : undefined;
  },
  entries() {
    return items[Symbol.iterator]();
  },
});

test('APIManager preserves string payloads without double encoding', async () => {
  let captured;
  const fetchStub = async (url, options) => {
    captured = { url, options };
    return {
      ok: true,
      status: 200,
      headers: createHeaders([['content-type', 'text/plain']]),
      text: async () => 'pong',
    };
  };

  const manager = new APIManager(loggerStub, securityStub, validationStub, { fetch: fetchStub });
  const result = await manager.request('POST', 'https://example.com', { data: 'ping' });

  assert.equal(captured.options.body, 'ping');
  assert.equal(captured.options.headers['Content-Type'], 'text/plain; charset=utf-8');
  assert.equal(result.data, 'pong');
});

test('APIManager defaults to JSON for object payloads and respects custom headers', async () => {
  let capturedHeaders;
  const fetchStub = async (_url, options) => {
    capturedHeaders = options.headers;
    return {
      ok: true,
      status: 201,
      headers: createHeaders([['content-type', 'application/json']]),
      json: async () => ({ echoed: options.body }),
    };
  };

  const manager = new APIManager(loggerStub, securityStub, validationStub, { fetch: fetchStub });
  const result = await manager.request('PUT', 'https://example.com', {
    data: { status: 'ok' },
    headers: { 'Content-Type': 'application/vnd.custom+json' },
  });

  assert.equal(result.status, 201);
  assert.equal(result.data.echoed, JSON.stringify({ status: 'ok' }));
  assert.equal(capturedHeaders['Content-Type'], 'application/vnd.custom+json');
});
