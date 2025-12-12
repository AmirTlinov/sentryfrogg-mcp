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
  ensureConnectionProfile(profile) {
    return { ...profile };
  },
  ensureLimit(limit) {
    return limit ?? 100;
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
  ensureWhereClause(where) {
    return where;
  },
  ensureSql(sql) {
    return sql;
  },
};

const profileServiceStub = () => {
  return {
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
  };
};

test('setupProfile invalidates existing pool after successful update', async () => {
  const service = profileServiceStub();
  const manager = new PostgreSQLManager(loggerStub, {}, validationStub, service);
  manager.testConnection = async () => {};

  let closed = false;
  manager.pools.set('default', {
    async end() {
      closed = true;
    },
  });

  await manager.setupProfile('default', {
    host: 'db.local',
    port: 5432,
    username: 'service',
    password: 'secret',
    database: 'warehouse',
  });

  assert.ok(closed, 'expected existing pool to be closed');
  assert.equal(manager.pools.has('default'), false);
});

test('describeTable honours provided schema', async () => {
  const service = profileServiceStub();
  service.stored.set('default', {
    host: 'db',
    port: 5432,
    username: 'x',
    password: 'p',
    database: 'd',
    ssl: false,
  });

  const manager = new PostgreSQLManager(loggerStub, {}, validationStub, service);
  manager.pools.clear();
  manager.getPool = async () => ({
    async query(sql, params) {
      return { rows: [{ sql, params }] };
    },
  });

  const result = await manager.describeTable('default', 'orders', 'analytics');
  assert.equal(result.schema, 'analytics');
  assert.deepEqual(result.columns[0].params, ['analytics', 'orders']);
});

test('sampleData qualifies schema name in generated SQL', async () => {
  const service = profileServiceStub();
  service.stored.set('default', {
    host: 'db',
    port: 5432,
    username: 'x',
    password: 'p',
    database: 'd',
    ssl: false,
  });

  const manager = new PostgreSQLManager(loggerStub, {}, validationStub, service);
  let capturedSql;
  manager.getPool = async () => ({
    async query(sql, params) {
      capturedSql = { sql, params };
      return { rowCount: 1, rows: [{ id: 1 }] };
    },
  });

  const result = await manager.sampleData('default', 'orders', 5, 'analytics');
  assert.equal(capturedSql.sql, 'SELECT * FROM analytics.orders LIMIT $1');
  assert.deepEqual(capturedSql.params, [5]);
  assert.equal(result.schema, 'analytics');
});
