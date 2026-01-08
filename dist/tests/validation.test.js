"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// @ts-nocheck
const test = require('node:test');
const assert = require('node:assert/strict');
const Validation = require('../src/services/Validation');
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
test('ensureHeaders normalizes values to strings and drops nulls', () => {
    const validation = createValidation();
    const headers = validation.ensureHeaders({
        Accept: 'application/json',
        'X-Count': 12,
        'X-Flag': false,
        'X-Empty': null,
    });
    assert.deepEqual(headers, {
        Accept: 'application/json',
        'X-Count': '12',
        'X-Flag': 'false',
    });
});
