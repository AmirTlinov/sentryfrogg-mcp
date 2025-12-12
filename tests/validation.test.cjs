const test = require('node:test');
const assert = require('node:assert/strict');
const Validation = require('../src/services/Validation.cjs');

const createValidation = () => new Validation({
  child() {
    return this;
  },
});

test('ensureString preserves whitespace when trimming disabled', () => {
  const validation = createValidation();
  const secret = ' secret surrounded by spaces ';

  assert.strictEqual(validation.ensureString(secret, 'Secret', { trim: false }), secret);
});

test('ensureString rejects whitespace-only secret even without trimming', () => {
  const validation = createValidation();

  assert.throws(() => validation.ensureString('   ', 'Secret', { trim: false }), /must be a non-empty string/);
});

test('ensureConnectionProfile keeps password untouched but normalizes other fields', () => {
  const validation = createValidation();
  const profile = {
    host: 'db.example.com ',
    port: '2200',
    username: ' admin ',
    password: ' pass-with-space ',
  };

  const normalized = validation.ensureConnectionProfile(profile, { defaultPort: 22, requirePassword: true });

  assert.strictEqual(normalized.host, 'db.example.com');
  assert.strictEqual(normalized.port, 2200);
  assert.strictEqual(normalized.username, 'admin');
  assert.strictEqual(normalized.password, ' pass-with-space ');
});
