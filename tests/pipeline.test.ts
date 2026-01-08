// @ts-nocheck
const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough, Readable } = require('node:stream');

const PipelineManager = require('../src/managers/PipelineManager');
const Validation = require('../src/services/Validation');

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

test('PipelineManager streams Postgres export into HTTP', async () => {
  let received = '';

  const apiManager = {
    async resolveProfile() {
      return { name: 'test', data: {}, auth: undefined, authProvider: undefined, retry: undefined };
    },
    async resolveAuthProvider() {
      return undefined;
    },
    async fetchWithRetry(args, profile, auth, overrides) {
      for await (const chunk of overrides.body) {
        received += chunk.toString();
      }

      const response = new MockResponse();
      response.headers = new Map([['content-type', 'text/plain']]);

      return {
        response,
        config: { url: args.url, method: args.method },
        attempts: 1,
        retries: 0,
      };
    },
  };

  const postgresqlManager = {
    exportStream() {
      return {
        stream: Readable.from('{"name":"a"}\n{"name":"b"}\n'),
        completion: Promise.resolve({
          rows_written: 2,
          format: 'jsonl',
          table: 'events',
          schema: 'public',
          duration_ms: 5,
        }),
      };
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
    flow: 'postgres_to_http',
    http: { url: 'https://sink.local/upload' },
    postgres: { table: 'events' },
    format: 'jsonl',
  });

  assert.equal(result.success, true);
  assert.equal(result.postgres.rows_written, 2);
  assert.equal(result.http.method, 'POST');
  assert.equal(received, '{"name":"a"}\n{"name":"b"}\n');
});

test('PipelineManager streams Postgres export into SFTP', async () => {
  const chunks = [];

  const sftp = {
    stat(path, cb) {
      const error = new Error('missing');
      error.code = 2;
      cb(error);
    },
    createWriteStream() {
      const stream = new PassThrough();
      stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      return stream;
    },
  };

  const sshManager = {
    async withSftp(args, fn) {
      return fn(sftp);
    },
    async ensureRemoteDir() {},
  };

  const postgresqlManager = {
    exportStream() {
      return {
        stream: Readable.from('id,name\n1,alpha\n'),
        completion: Promise.resolve({
          rows_written: 1,
          format: 'csv',
          table: 'items',
          schema: 'public',
          duration_ms: 4,
        }),
      };
    },
  };

  const pipelineManager = new PipelineManager(
    loggerStub,
    new Validation(loggerStub),
    {},
    sshManager,
    postgresqlManager,
    null,
    null
  );

  const result = await pipelineManager.handleAction({
    action: 'run',
    flow: 'postgres_to_sftp',
    postgres: { table: 'items' },
    sftp: { remote_path: '/tmp/items.csv' },
    format: 'csv',
  });

  assert.equal(result.success, true);
  assert.equal(result.sftp.remote_path, '/tmp/items.csv');
  assert.equal(Buffer.concat(chunks).toString('utf8'), 'id,name\n1,alpha\n');
});
