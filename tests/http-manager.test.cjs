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
  ensureString(value) {
    return value;
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

const createHeaders = (items) => ({
  get(key) {
    const found = items.find(([name]) => name.toLowerCase() === key.toLowerCase());
    return found ? found[1] : undefined;
  },
  entries() {
    return items[Symbol.iterator]();
  },
});

const createResponse = ({ status, body, contentType }) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: status === 200 ? 'OK' : 'Error',
  headers: createHeaders([['content-type', contentType || 'application/json']]),
  async json() {
    return typeof body === 'string' ? JSON.parse(body) : body;
  },
  async text() {
    return typeof body === 'string' ? body : JSON.stringify(body);
  },
  async arrayBuffer() {
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
    return Buffer.from(raw);
  },
});

test('APIManager retries on retryable status codes', async () => {
  let calls = 0;
  const fetchStub = async () => {
    calls += 1;
    if (calls === 1) {
      return createResponse({ status: 503, body: { ok: false } });
    }
    return createResponse({ status: 200, body: { ok: true } });
  };

  const manager = new APIManager(loggerStub, securityStub, validationStub, profileServiceStub(), null, { fetch: fetchStub });
  const result = await manager.request({ method: 'GET', url: 'https://example.com' });

  assert.equal(calls, 2);
  assert.equal(result.status, 200);
  assert.equal(result.attempts, 2);
});

test('APIManager paginates using page-based pagination', async () => {
  const fetchStub = async (url) => {
    const parsed = new URL(url);
    const page = Number(parsed.searchParams.get('page') || '1');
    const body = page < 3 ? { items: [page] } : { items: [] };
    return createResponse({ status: 200, body });
  };

  const manager = new APIManager(loggerStub, securityStub, validationStub, profileServiceStub(), null, { fetch: fetchStub });
  const result = await manager.paginate({
    method: 'GET',
    url: 'https://example.com/items',
    pagination: {
      type: 'page',
      param: 'page',
      size_param: 'limit',
      size: 1,
      max_pages: 5,
      item_path: 'data.items',
    },
  });

  assert.equal(result.page_count, 3);
  assert.deepEqual(result.items, [1, 2]);
});
