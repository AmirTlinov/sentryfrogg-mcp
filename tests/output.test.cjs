const test = require('node:test');
const assert = require('node:assert/strict');
const { applyOutputTransform } = require('../src/utils/output.cjs');

test('output.missing=error throws when path is missing (default)', () => {
  assert.throws(() => applyOutputTransform({ ok: true }, { path: 'missing.path' }), /not found/);
});

test('output.missing=null returns null when path is missing', () => {
  const shaped = applyOutputTransform({ ok: true }, { path: 'missing.path', missing: 'null' });
  assert.equal(shaped, null);
});

test('output.missing=undefined returns undefined when path is missing', () => {
  const shaped = applyOutputTransform({ ok: true }, { path: 'missing.path', missing: 'undefined' });
  assert.equal(shaped, undefined);
});

test('output.missing=empty returns {} when pick/omit implies object', () => {
  const shaped = applyOutputTransform({ ok: true }, { path: 'missing.path', missing: 'empty', pick: ['id'] });
  assert.deepEqual(shaped, {});
});

test('output.missing=empty returns [] when map implies array', () => {
  const shaped = applyOutputTransform({ ok: true }, { path: 'missing.path', missing: 'empty', map: { pick: ['id'] } });
  assert.deepEqual(shaped, []);
});

test('output.map throws when value is not an array and missing=error', () => {
  assert.throws(
    () => applyOutputTransform({ rows: { id: 1 } }, { path: 'rows', map: { pick: ['id'] } }),
    /expects an array/
  );
});

test('output.map returns [] when value is not an array and missing=empty', () => {
  const shaped = applyOutputTransform(
    { rows: { id: 1 } },
    { path: 'rows', missing: 'empty', map: { pick: ['id'] } }
  );
  assert.deepEqual(shaped, []);
});

test('output.default overrides missing behavior and still participates in map', () => {
  const shaped = applyOutputTransform(
    { ok: true },
    {
      path: 'rows',
      missing: 'null',
      default: [{ id: 1, secret: 'nope' }],
      map: { pick: ['id'] },
    }
  );
  assert.deepEqual(shaped, [{ id: 1 }]);
});

