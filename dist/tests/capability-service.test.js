"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// @ts-nocheck
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const CapabilityService = require('../src/services/CapabilityService');
const loggerStub = {
    child() {
        return this;
    },
    info() { },
    warn() { },
    error() { },
};
const securityStub = {
    ensureSizeFits() { },
};
test('CapabilityService persists and resolves intents', async (t) => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sentryfrogg-capabilities-'));
    const previousCapabilities = process.env.MCP_CAPABILITIES_PATH;
    process.env.MCP_CAPABILITIES_PATH = path.join(tmpRoot, 'capabilities.json');
    t.after(async () => {
        if (previousCapabilities === undefined) {
            delete process.env.MCP_CAPABILITIES_PATH;
        }
        else {
            process.env.MCP_CAPABILITIES_PATH = previousCapabilities;
        }
        await fs.rm(tmpRoot, { recursive: true, force: true });
    });
    const service = new CapabilityService(loggerStub, securityStub);
    await service.initialize();
    await service.setCapability('demo.read', {
        intent: 'demo.read',
        runbook: 'demo.run',
        inputs: { required: ['id'] },
        effects: { kind: 'read', requires_apply: false },
    });
    const list = await service.listCapabilities();
    const entry = list.find((item) => item.name === 'demo.read');
    assert.ok(entry);
    assert.equal(entry.source, 'local');
    const resolved = await service.findByIntent('demo.read');
    assert.equal(resolved.runbook, 'demo.run');
    const byName = await service.getCapability('demo.read');
    assert.equal(byName.intent, 'demo.read');
});
