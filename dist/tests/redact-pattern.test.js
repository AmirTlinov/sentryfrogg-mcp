"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// @ts-nocheck
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const redact_1 = require("../src/utils/redact");
(0, node_test_1.default)('redactText masks OpenAI-style keys and common token= leaks', () => {
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
    const out = (0, redact_1.redactText)(input);
    strict_1.default.ok(out.includes('sk-***REDACTED***'));
    strict_1.default.ok(out.includes('ghp_***REDACTED***'));
    strict_1.default.ok(out.includes('github_pat_***REDACTED***'));
    strict_1.default.ok(out.includes('glpat-***REDACTED***'));
    strict_1.default.ok(out.includes('***REDACTED***'));
    strict_1.default.ok(out.includes('AIza***REDACTED***'));
    strict_1.default.ok(out.includes('token=***REDACTED***'));
    strict_1.default.ok(out.includes('password:***REDACTED***'));
});
(0, node_test_1.default)('redactObject applies inline redaction to nested strings', () => {
    const out = (0, redact_1.redactObject)({
        stdout: 'Bearer abcdefghijklmnopqrstuvwxyz123456',
        nested: { jwt: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c' },
    }, { maxString: 10_000 });
    strict_1.default.equal(out.stdout, 'Bearer ***REDACTED***');
    strict_1.default.equal(out.nested.jwt, '***REDACTED***');
});
