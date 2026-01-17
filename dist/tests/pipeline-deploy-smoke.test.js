"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// @ts-nocheck
const test = require('node:test');
const assert = require('node:assert/strict');
const PipelineManager = require('../src/managers/PipelineManager');
const Validation = require('../src/services/Validation');
const loggerStub = {
    child() {
        return this;
    },
    warn() { },
    info() { },
    error() { },
};
test('pipeline.deploy_smoke deploys via ssh.deploy_file then smokes via api.smoke_http', async () => {
    let deployCalls = 0;
    let smokeCalls = 0;
    const sshManager = {
        async deployFile(args) {
            deployCalls += 1;
            assert.equal(args.action, 'deploy_file');
            assert.equal(args.local_path, '/local.bin');
            assert.equal(args.remote_path, '/remote.bin');
            return { success: true, verified: true, remote_path: args.remote_path };
        },
    };
    const apiManager = {
        async smokeHttp(args) {
            smokeCalls += 1;
            assert.equal(args.action, 'smoke_http');
            assert.equal(args.url, 'http://example.test/health');
            return { success: true, ok: true, status: 200, expect_code: 200, body_preview: 'ok' };
        },
    };
    const pipeline = new PipelineManager(loggerStub, new Validation(loggerStub), apiManager, sshManager, null, null, null, null);
    const result = await pipeline.handleAction({
        action: 'deploy_smoke',
        local_path: '/local.bin',
        remote_path: '/remote.bin',
        url: 'http://example.test/health',
        smoke_attempts: 3,
        smoke_delay_ms: 0,
    });
    assert.equal(result.success, true);
    assert.equal(deployCalls, 1);
    assert.equal(smokeCalls, 1);
    assert.equal(result.deploy.verified, true);
    assert.equal(result.smoke.ok, true);
});
test('pipeline.deploy_smoke retries smoke until ok', async () => {
    let smokeCalls = 0;
    const sshManager = {
        async deployFile() {
            return { success: true, verified: true };
        },
    };
    const apiManager = {
        async smokeHttp() {
            smokeCalls += 1;
            if (smokeCalls < 3) {
                return { success: true, ok: false, status: 503, expect_code: 200, body_preview: 'warming' };
            }
            return { success: true, ok: true, status: 200, expect_code: 200, body_preview: 'ok' };
        },
    };
    const pipeline = new PipelineManager(loggerStub, new Validation(loggerStub), apiManager, sshManager, null, null, null, null);
    const result = await pipeline.handleAction({
        action: 'deploy_smoke',
        local_path: '/local.bin',
        remote_path: '/remote.bin',
        url: 'http://example.test/health',
        smoke_attempts: 5,
        smoke_delay_ms: 0,
    });
    assert.equal(result.success, true);
    assert.equal(smokeCalls, 3);
    assert.equal(result.attempts.ok_at, 3);
});
test('pipeline.deploy_smoke returns DEPLOY_FAILED when deploy fails', async () => {
    const sshManager = {
        async deployFile() {
            return { success: false, code: 'UPLOAD_FAILED' };
        },
    };
    const apiManager = {
        async smokeHttp() {
            throw new Error('should not be called');
        },
    };
    const pipeline = new PipelineManager(loggerStub, new Validation(loggerStub), apiManager, sshManager, null, null, null, null);
    const result = await pipeline.handleAction({
        action: 'deploy_smoke',
        local_path: '/local.bin',
        remote_path: '/remote.bin',
        url: 'http://example.test/health',
        smoke_attempts: 3,
        smoke_delay_ms: 0,
    });
    assert.equal(result.success, false);
    assert.equal(result.code, 'DEPLOY_FAILED');
    assert.equal(result.smoke, null);
});
