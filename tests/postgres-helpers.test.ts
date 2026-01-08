// @ts-nocheck
const test = require('node:test');
const assert = require('node:assert/strict');
const PostgreSQLManager = require('../src/managers/PostgreSQLManager');

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
  async listProfiles() {
    return [];
  },
  async getProfile() {
    return { data: {}, secrets: {} };
  },
});

test('select builds a safe query with filters/order/limit/offset', async () => {
  const manager = new PostgreSQLManager(loggerStub, validationStub, profileServiceStub());
  manager.resolveConnection = async () => ({ connection: {}, poolOptions: {}, profileName: undefined });
  manager.getPool = async () => ({});

  let captured;
  manager.executeQuery = async (_pool, sql, params) => {
    captured = { sql, params };
    return { rows: [], fields: [] };
  };

  await manager.select({
    table: 'orders',
    columns: ['id', 'status'],
    filters: { status: 'open' },
    order_by: { column: 'id', direction: 'DESC' },
    limit: 5,
    offset: 10,
  });

  assert.ok(captured.sql.includes('SELECT "id", "status" FROM "orders"'));
  assert.ok(captured.sql.includes('WHERE "status" = $1'));
  assert.ok(captured.sql.includes('ORDER BY "id" DESC'));
  assert.ok(captured.sql.includes('LIMIT 5'));
  assert.ok(captured.sql.includes('OFFSET 10'));
  assert.deepEqual(captured.params, ['open']);
});

test('count returns numeric value', async () => {
  const manager = new PostgreSQLManager(loggerStub, validationStub, profileServiceStub());
  manager.resolveConnection = async () => ({ connection: {}, poolOptions: {}, profileName: undefined });
  manager.getPool = async () => ({});

  manager.executeQuery = async () => ({ row: { count: '12' } });

  const result = await manager.count({ table: 'orders' });
  assert.equal(result.count, 12);
});

test('exists returns boolean', async () => {
  const manager = new PostgreSQLManager(loggerStub, validationStub, profileServiceStub());
  manager.resolveConnection = async () => ({ connection: {}, poolOptions: {}, profileName: undefined });
  manager.getPool = async () => ({});

  manager.executeQuery = async () => ({ row: { exists: true } });

  const result = await manager.exists({ table: 'orders' });
  assert.equal(result.exists, true);
});
