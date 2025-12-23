const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

const PipelineManager = require('../src/managers/PipelineManager.cjs');
const Validation = require('../src/services/Validation.cjs');

const loggerStub = {
  child() {
    return this;
  },
  warn() {},
  info() {},
  error() {},
};

class MockResponse {
  constructor(body) {
    this.ok = true;
    this.status = 200;
    this.headers = new Map();
    this.body = body;
  }

  async text() {
    return '';
  }
}

test('PipelineManager ingests HTTP JSONL into Postgres', async () => {
  const body = Readable.from('{"name":"a"}\n{"name":"b"}\n');

  const apiManager = {
    async resolveProfile() {
      return { name: 'test', data: {}, auth: undefined, authProvider: undefined, retry: undefined };
    },
    async resolveAuthProvider() {
      return undefined;
    },
    buildRequestConfig() {
      return { url: 'http://local', method: 'GET', headers: {} };
    },
    async fetchWithRetry() {
      return { response: new MockResponse(body), config: {}, duration_ms: 1, attempts: 1, retries: 0 };
    },
  };

  const insertedBatches = [];
  const postgresqlManager = {
    async insertBulk({ rows }) {
      insertedBatches.push(rows);
      return { inserted: rows.length };
    },
  };

  const pipelineManager = new PipelineManager(
    loggerStub,
    new Validation(loggerStub),
    apiManager,
    {},
    postgresqlManager,
    null,
    null
  );

  const result = await pipelineManager.handleAction({
    action: 'run',
    flow: 'http_to_postgres',
    http: { url: 'http://local' },
    postgres: { table: 'items' },
    format: 'jsonl',
    batch_size: 1,
  });

  assert.equal(result.success, true);
  assert.equal(result.postgres.inserted, 2);
  assert.equal(insertedBatches.length, 2);
});
