const test = require('node:test');
const assert = require('node:assert/strict');
const PostgreSQLManager = require('../src/managers/PostgreSQLManager.cjs');

const loggerStub = {
  child() {
    return this;
  },
  warn() {},
  error() {},
  info() {},
};

const validationStub = {
  ensureString(value) {
    return value;
  },
  ensureTableName(name) {
    return name;
  },
  ensureSchemaName(name) {
    return name;
  },
  ensureDataObject(data) {
    return data;
  },
  ensureSql(sql) {
    return sql;
  },
};

const profileServiceStub = () => ({
  stored: new Map(),
  async setProfile(name, config) {
    this.stored.set(name, config);
  },
  async listProfiles() {
    return [];
  },
  async getProfile(name) {
    return this.stored.get(name);
  },
  async deleteProfile(name) {
    this.stored.delete(name);
  },
});

test('profileUpsert invalidates existing pool after successful update', async () => {
  const service = profileServiceStub();
  const manager = new PostgreSQLManager(loggerStub, validationStub, service);
  manager.testConnection = async () => {};

  let closed = false;
  manager.pools.set('profile:default', {
    async end() {
      closed = true;
    },
  });

  await manager.profileUpsert('default', {
    connection: {
      host: 'db.local',
      port: 5432,
      username: 'service',
      password: 'secret',
      database: 'warehouse',
    },
  });

  assert.ok(closed, 'expected existing pool to be closed');
  assert.equal(manager.pools.has('profile:default'), false);
});

test('catalogColumns honours provided schema', async () => {
  const service = profileServiceStub();
  service.stored.set('default', {
    data: {
      host: 'db',
      port: 5432,
      username: 'x',
      password: 'p',
      database: 'd',
      ssl: false,
    },
  });

  const manager = new PostgreSQLManager(loggerStub, validationStub, service);
  let capturedParams;
  manager.getPool = async () => ({
    async query(config) {
      capturedParams = config.values;
      return { command: 'SELECT', rowCount: 1, rows: [{ ok: true }], fields: [] };
    },
  });

  const result = await manager.catalogColumns({ profile_name: 'default', table: 'orders', schema: 'analytics' });
  assert.equal(result.schema, 'analytics');
  assert.deepEqual(capturedParams, ['analytics', 'orders']);
});

test('insert quotes identifiers and returns metadata', async () => {
  const service = profileServiceStub();
  const manager = new PostgreSQLManager(loggerStub, validationStub, service);

  let capturedSql;
  let capturedValues;
  manager.getPool = async () => ({
    async query(config) {
      capturedSql = config.text;
      capturedValues = config.values;
      return { command: 'INSERT', rowCount: 1, rows: [{ id: 1 }], fields: [] };
    },
  });

  const result = await manager.insert({
    connection: {},
    table: 'analytics.orders',
    data: { status: 'new', amount: 10 },
    returning: true,
  });

  assert.ok(capturedSql.includes('"analytics"."orders"'));
  assert.ok(capturedSql.includes('"status"'));
  assert.ok(capturedSql.includes('"amount"'));
  assert.ok(capturedSql.includes('RETURNING *'));
  assert.deepEqual(capturedValues, ['new', 10]);
  assert.equal(result.command, 'INSERT');
});

test('update and delete allow missing filters', async () => {
  const service = profileServiceStub();
  const manager = new PostgreSQLManager(loggerStub, validationStub, service);

  let capturedUpdateSql;
  let capturedDeleteSql;
  manager.getPool = async () => ({
    async query(config) {
      if (config.text.startsWith('UPDATE')) {
        capturedUpdateSql = config.text;
      } else if (config.text.startsWith('DELETE')) {
        capturedDeleteSql = config.text;
      }
      return { command: 'OK', rowCount: 0, rows: [], fields: [] };
    },
  });

  await manager.update({ connection: {}, table: 'orders', data: { status: 'archived' } });
  await manager.remove({ connection: {}, table: 'orders' });

  assert.ok(!capturedUpdateSql.includes('WHERE'));
  assert.ok(!capturedDeleteSql.includes('WHERE'));
});
