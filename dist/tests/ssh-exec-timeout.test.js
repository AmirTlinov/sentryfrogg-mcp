"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// @ts-nocheck
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const SSHManager = require('../src/managers/SSHManager');
const loggerStub = {
    child() {
        return this;
    },
    info() { },
    warn() { },
    error() { },
};
const validationStub = {
    ensurePort(value, fallback) {
        return value ?? fallback;
    },
    ensureString(value) {
        return String(value);
    },
};
const securityStub = {
    cleanCommand(value) {
        return value;
    },
};
test('SSHManager exec settles on hard timeout even if stream never closes', async () => {
    const manager = new SSHManager(loggerStub, securityStub, validationStub, null, null, null);
    const previousGrace = process.env.SENTRYFROGG_SSH_EXEC_HARD_GRACE_MS;
    try {
        process.env.SENTRYFROGG_SSH_EXEC_HARD_GRACE_MS = '5';
        const stream = new EventEmitter();
        stream.stderr = new EventEmitter();
        stream.close = () => { };
        stream.destroy = () => { };
        const client = {
            exec(_command, _options, cb) {
                cb(null, stream);
            },
            destroy() { },
        };
        const result = await manager.exec(client, 'echo hi', {}, { timeout_ms: 20 });
        assert.equal(result.timedOut, true);
        assert.equal(result.hardTimedOut, true);
        assert.equal(result.exitCode, null);
    }
    finally {
        if (previousGrace === undefined) {
            delete process.env.SENTRYFROGG_SSH_EXEC_HARD_GRACE_MS;
        }
        else {
            process.env.SENTRYFROGG_SSH_EXEC_HARD_GRACE_MS = previousGrace;
        }
    }
});
