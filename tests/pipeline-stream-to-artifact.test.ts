// @ts-nocheck
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');

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

function restoreEnv(key, previous) {
  if (previous === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = previous;
  }
}

test('PipelineManager stream-to-artifact captures HTTP body without breaking ingestion', async (t) => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sentryfrogg-pipeline-stream-'));
  t.after(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  const prevContext = process.env.SF_CONTEXT_REPO_ROOT;
  const prevStream = process.env.SF_PIPELINE_STREAM_TO_ARTIFACT;
  const prevMaxCapture = process.env.SF_PIPELINE_MAX_CAPTURE_BYTES;

  try {
    process.env.SF_CONTEXT_REPO_ROOT = tmpRoot;
    process.env.SF_PIPELINE_STREAM_TO_ARTIFACT = 'true';
    process.env.SF_PIPELINE_MAX_CAPTURE_BYTES = '10';

    const body = Readable.from([Buffer.from('{"name":"a"}\n{"name":"b"}\n')]);

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
      trace_id: 'trace-1',
      span_id: 'span-1',
      http: { url: 'http://local' },
      postgres: { table: 'items' },
      format: 'jsonl',
      batch_size: 1,
    });

    assert.equal(result.success, true);
    assert.equal(result.postgres.inserted, 2);
    assert.equal(insertedBatches.length, 2);

    assert.ok(result.http.body_ref);
    assert.equal(result.http.body_ref_truncated, true);
    assert.equal(result.http.body_ref.bytes, 10);

    const bodyPath = path.join(tmpRoot, 'artifacts', result.http.body_ref.rel);
    const stored = await fs.readFile(bodyPath, 'utf8');
    assert.equal(stored.length, 10);
  } finally {
    restoreEnv('SF_CONTEXT_REPO_ROOT', prevContext);
    restoreEnv('SF_PIPELINE_STREAM_TO_ARTIFACT', prevStream);
    restoreEnv('SF_PIPELINE_MAX_CAPTURE_BYTES', prevMaxCapture);
  }
});
