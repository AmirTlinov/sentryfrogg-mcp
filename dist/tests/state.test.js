"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// @ts-nocheck
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const StateService = require('../src/services/StateService');
const loggerStub = {
    child() {
        return this;
    },
    warn() { },
    info() { },
    error() { },
};
async function withTempStateStore(task) {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sentryfrogg-state-'));
    const prevProfilesDir = process.env.MCP_PROFILES_DIR;
    const prevStatePath = process.env.MCP_STATE_PATH;
    process.env.MCP_PROFILES_DIR = baseDir;
    process.env.MCP_STATE_PATH = path.join(baseDir, 'state.json');
    try {
        await task(baseDir);
    }
    finally {
        if (prevProfilesDir === undefined) {
            delete process.env.MCP_PROFILES_DIR;
        }
        else {
            process.env.MCP_PROFILES_DIR = prevProfilesDir;
        }
        if (prevStatePath === undefined) {
            delete process.env.MCP_STATE_PATH;
        }
        else {
            process.env.MCP_STATE_PATH = prevStatePath;
        }
        await fs.rm(baseDir, { recursive: true, force: true });
    }
}
test('StateService persists persistent keys and isolates session keys', async () => {
    await withTempStateStore(async () => {
        const service = new StateService(loggerStub);
        await service.initialize();
        await service.set('alpha', 123, 'persistent');
        await service.set('temp', 'ping', 'session');
        const persistent = await service.get('alpha', 'persistent');
        const session = await service.get('temp', 'session');
        assert.equal(persistent.value, 123);
        assert.equal(session.value, 'ping');
        const snapshot = await service.dump('any');
        assert.equal(snapshot.state.alpha, 123);
        assert.equal(snapshot.state.temp, 'ping');
        const reload = new StateService(loggerStub);
        await reload.initialize();
        const reloaded = await reload.get('alpha');
        assert.equal(reloaded.value, 123);
        const missingSession = await reload.get('temp');
        assert.equal(missingSession.value, undefined);
    });
});
