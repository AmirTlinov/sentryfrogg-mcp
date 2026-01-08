"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// @ts-nocheck
const test = require('node:test');
const assert = require('node:assert/strict');
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
test('SSHManager withClientRetry resets and retries on channel open failure', async () => {
    const manager = new SSHManager(loggerStub, securityStub, validationStub, null, null, null);
    let attempts = 0;
    manager.withClient = async (_profileName, _args, handler) => {
        attempts += 1;
        if (attempts === 1) {
            throw new Error('(SSH) Channel open failure: open failed');
        }
        return handler({});
    };
    let resets = 0;
    manager.resetProfileConnection = async () => {
        resets += 1;
        return { success: true };
    };
    const result = await manager.withClientRetry('ssh1', {}, async () => 'ok');
    assert.equal(result, 'ok');
    assert.equal(attempts, 2);
    assert.equal(resets, 1);
});
test('SSHManager execDetached returns pid and paths', async () => {
    const manager = new SSHManager(loggerStub, securityStub, validationStub, null, null, null);
    manager.resolveConnection = async () => ({ connection: {}, profileName: null });
    let received = null;
    manager.execOnce = async (_connection, command) => {
        received = command;
        return {
            stdout: '4321\n',
            stderr: '',
            exitCode: 0,
            signal: null,
            timedOut: false,
            duration_ms: 1,
        };
    };
    const result = await manager.execDetached({
        command: 'sleep 10',
        log_path: '/tmp/sentryfrogg-detached.log',
        pid_path: '/tmp/sentryfrogg-detached.pid',
    });
    assert.equal(result.success, true);
    assert.equal(result.pid, 4321);
    assert.equal(result.log_path, '/tmp/sentryfrogg-detached.log');
    assert.equal(result.pid_path, '/tmp/sentryfrogg-detached.pid');
    assert.ok(received.includes('nohup'));
    assert.ok(received.includes('/tmp/sentryfrogg-detached.log'));
    assert.ok(received.includes('/tmp/sentryfrogg-detached.pid'));
});
