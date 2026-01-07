const test = require('node:test');
const assert = require('node:assert/strict');

const JobService = require('../src/services/JobService.cjs');
const JobManager = require('../src/managers/JobManager.cjs');

const loggerStub = {
  child() {
    return this;
  },
  info() {},
  warn() {},
  error() {},
};

const validationStub = {
  ensureString(value, label) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`${label} must be a non-empty string`);
    }
    return value.trim();
  },
};

test('JobService enforces maxJobs via LRU eviction', () => {
  const prevMax = process.env.SF_JOBS_MAX;
  process.env.SF_JOBS_MAX = '2';

  const service = new JobService(loggerStub);
  service.create({ kind: 'one' });
  service.create({ kind: 'two' });
  service.create({ kind: 'three' });

  assert.equal(service.getStats().jobs, 2);

  if (prevMax === undefined) {
    delete process.env.SF_JOBS_MAX;
  } else {
    process.env.SF_JOBS_MAX = prevMax;
  }
});

test('JobService cancel aborts and marks job canceled', () => {
  const service = new JobService(loggerStub);
  const job = service.create({ kind: 'task' });
  const signal = service.getAbortSignal(job.job_id);
  assert.equal(signal.aborted, false);

  const canceled = service.cancel(job.job_id, 'test');
  assert.equal(canceled.status, 'canceled');
  assert.equal(signal.aborted, true);
});

test('JobService purgeExpired removes expired jobs', () => {
  const prevTtl = process.env.SF_JOBS_TTL_MS;
  process.env.SF_JOBS_TTL_MS = '1';

  const service = new JobService(loggerStub);
  const job = service.create({ kind: 'task' });
  service.purgeExpired(Date.now() + 10_000);
  assert.equal(service.get(job.job_id), null);

  if (prevTtl === undefined) {
    delete process.env.SF_JOBS_TTL_MS;
  } else {
    process.env.SF_JOBS_TTL_MS = prevTtl;
  }
});

test('JobManager supports list/cancel/forget for inprocess jobs', async () => {
  const service = new JobService(loggerStub);
  const job = service.create({ kind: 'inprocess_task' });
  service.upsert({ job_id: job.job_id, status: 'running' });

  const manager = new JobManager(loggerStub, validationStub, service, {});
  const listed = await manager.handleAction({ action: 'job_list', limit: 10 });
  assert.equal(listed.success, true);
  assert.ok(listed.jobs.some((entry) => entry.job_id === job.job_id));

  const canceled = await manager.handleAction({ action: 'job_cancel', job_id: job.job_id });
  assert.equal(canceled.success, true);
  assert.equal(canceled.job.status, 'canceled');

  const forgotten = await manager.handleAction({ action: 'job_forget', job_id: job.job_id });
  assert.equal(forgotten.success, true);
  assert.equal(forgotten.removed, true);
});
