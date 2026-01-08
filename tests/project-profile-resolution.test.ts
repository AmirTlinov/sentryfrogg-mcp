// @ts-nocheck
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

const Validation = require('../src/services/Validation');
const ProjectResolver = require('../src/services/ProjectResolver');
const PostgreSQLManager = require('../src/managers/PostgreSQLManager');
const APIManager = require('../src/managers/APIManager');
const PipelineManager = require('../src/managers/PipelineManager');

const loggerStub = {
  child() {
    return this;
  },
  warn() {},
  info() {},
  error() {},
};

const securityStub = {
  ensureUrl(url) {
    return new URL(url);
  },
};

test('PostgreSQLManager resolves profile via project target (and active project)', async () => {
  const validation = new Validation(loggerStub);

  const projectServiceStub = {
    async getProject() {
      return {
        project: {
          default_target: 'prod',
          targets: {
            prod: { postgres_profile: 'pg-prod' },
          },
        },
      };
    },
  };

  const stateServiceStub = {
    async get() {
      return { value: 'myapp' };
    },
  };

  const resolver = new ProjectResolver(validation, projectServiceStub, stateServiceStub);
  const manager = new PostgreSQLManager(loggerStub, validation, { async listProfiles() { return []; } }, resolver);

  assert.equal(await manager.resolveProfileName(undefined, { project: 'myapp', target: 'prod' }), 'pg-prod');
  assert.equal(await manager.resolveProfileName(undefined, { target: 'prod' }), 'pg-prod');
});

test('PostgreSQLManager errors when project target has no postgres_profile', async () => {
  const validation = new Validation(loggerStub);

  const projectServiceStub = {
    async getProject() {
      return {
        project: {
          default_target: 'prod',
          targets: { prod: {} },
        },
      };
    },
  };

  const stateServiceStub = {
    async get() {
      return { value: 'myapp' };
    },
  };

  const resolver = new ProjectResolver(validation, projectServiceStub, stateServiceStub);
  const manager = new PostgreSQLManager(loggerStub, validation, { async listProfiles() { return []; } }, resolver);

  await assert.rejects(
    () => manager.resolveProfileName(undefined, { target: 'prod' }),
    /missing postgres_profile/
  );
});

test('APIManager defaults profile via project target when resolvable', async () => {
  const validation = new Validation(loggerStub);

  const projectServiceStub = {
    async getProject() {
      return {
        project: {
          default_target: 'prod',
          targets: {
            prod: { api_profile: 'api-prod' },
          },
        },
      };
    },
  };

  const stateServiceStub = {
    async get() {
      return { value: 'myapp' };
    },
  };

  const resolver = new ProjectResolver(validation, projectServiceStub, stateServiceStub);

  let usedProfile = null;
  const profileServiceStub = {
    async listProfiles() {
      return [];
    },
    async getProfile(name) {
      usedProfile = name;
      return { data: {}, secrets: {} };
    },
  };

  const manager = new APIManager(loggerStub, securityStub, validation, profileServiceStub, null, { projectResolver: resolver });
  await manager.resolveProfile(undefined, { target: 'prod' });
  assert.equal(usedProfile, 'api-prod');
});

test('PipelineManager injects project target profiles into http/postgres/sftp defaults', async () => {
  const validation = new Validation(loggerStub);

  const projectServiceStub = {
    async getProject() {
      return {
        project: {
          default_target: 'prod',
          targets: {
            prod: {
              api_profile: 'api-prod',
              postgres_profile: 'pg-prod',
              ssh_profile: 'ssh-prod',
            },
          },
        },
      };
    },
  };

  const stateServiceStub = {
    async get() {
      return { value: 'myapp' };
    },
  };

  const resolver = new ProjectResolver(validation, projectServiceStub, stateServiceStub);

  let resolvedHttpProfile = null;
  const apiManager = {
    async resolveProfile(profileName) {
      resolvedHttpProfile = profileName;
      return { name: profileName, data: {}, auth: undefined, authProvider: undefined, retry: undefined };
    },
    async resolveAuthProvider() {
      return undefined;
    },
    buildRequestConfig() {
      return { url: 'http://local', method: 'GET', headers: {} };
    },
    async fetchWithRetry() {
      return { response: { ok: true, status: 200, headers: new Map(), body: Readable.from('{"id":1}\n') }, config: {}, duration_ms: 1, attempts: 1, retries: 0 };
    },
  };

  let usedPostgresProfile = null;
  const postgresqlManager = {
    async insertBulk(args) {
      usedPostgresProfile = args.profile_name;
      return { inserted: 1 };
    },
    exportStream() {
      return {
        stream: Readable.from('id\n1\n'),
        completion: Promise.resolve({ rows_written: 1, format: 'csv', table: 'items', schema: 'public', duration_ms: 1 }),
      };
    },
  };

  let usedSftpProfile = null;
  const sftp = {
    stat(_path, cb) {
      const error = new Error('missing');
      error.code = 2;
      cb(error);
    },
    createWriteStream() {
      return new (require('node:stream').PassThrough)();
    },
  };

  const sshManager = {
    async withSftp(args, fn) {
      usedSftpProfile = args.profile_name;
      return fn(sftp);
    },
    async ensureRemoteDir() {},
  };

  const pipeline = new PipelineManager(loggerStub, validation, apiManager, sshManager, postgresqlManager, null, null, resolver);

  await pipeline.handleAction({
    action: 'run',
    flow: 'http_to_postgres',
    target: 'prod',
    http: { url: 'http://local' },
    postgres: { table: 'items' },
    format: 'jsonl',
  });

  assert.equal(resolvedHttpProfile, 'api-prod');
  assert.equal(usedPostgresProfile, 'pg-prod');

  await pipeline.handleAction({
    action: 'run',
    flow: 'postgres_to_sftp',
    target: 'prod',
    postgres: { table: 'items' },
    sftp: { remote_path: '/tmp/items.csv' },
    format: 'csv',
  });

  assert.equal(usedSftpProfile, 'ssh-prod');
});

