// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';

import { redactObject, redactText } from '../src/utils/redact';

test('redactText masks OpenAI-style keys and common token= leaks', () => {
  const input = [
    'sk-1234567890abcdefABCDEF',
    'ghp_1234567890abcdef1234567890abcdef1234',
    'github_pat_11AA22BB33CC44DD55EE66FF77GG88HH99II00JJ',
    'glpat-1234567890abcdef',
    'xoxb-1234567890-abcdef-1234567890',
    'AIzaSyDUMMYKEY_1234567890abcdef',
    'token=supersecretvalue',
    'password:hunter2',
  ].join('\n');

  const out = redactText(input);
  assert.ok(out.includes('sk-***REDACTED***'));
  assert.ok(out.includes('ghp_***REDACTED***'));
  assert.ok(out.includes('github_pat_***REDACTED***'));
  assert.ok(out.includes('glpat-***REDACTED***'));
  assert.ok(out.includes('***REDACTED***'));
  assert.ok(out.includes('AIza***REDACTED***'));
  assert.ok(out.includes('token=***REDACTED***'));
  assert.ok(out.includes('password:***REDACTED***'));
});

test('redactObject applies inline redaction to nested strings', () => {
  const out = redactObject(
    {
      stdout: 'Bearer abcdefghijklmnopqrstuvwxyz123456',
      nested: { jwt: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c' },
    },
    { maxString: 10_000 }
  );

  assert.equal(out.stdout, 'Bearer ***REDACTED***');
  assert.equal(out.nested.jwt, '***REDACTED***');
});
