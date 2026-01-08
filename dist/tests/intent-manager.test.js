"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// @ts-nocheck
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const CapabilityService = require('../src/services/CapabilityService');
const EvidenceService = require('../src/services/EvidenceService');
const IntentManager = require('../src/managers/IntentManager');
const ToolError = require('../src/errors/ToolError');
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
const validationStub = {
    ensureString(value, label) {
        if (typeof value !== 'string' || value.trim().length === 0) {
            throw new Error(`${label} must be a non-empty string`);
        }
        return value.trim();
    },
    ensureOptionalString(value, label) {
        if (value === undefined || value === null) {
            return undefined;
        }
        return this.ensureString(value, label);
    },
    ensureObject(value, label) {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            throw new Error(`${label} must be an object`);
        }
        return value;
    },
    ensureOptionalObject(value, label) {
        if (value === undefined || value === null) {
            return undefined;
        }
        return this.ensureObject(value, label);
    },
};
test('IntentManager compiles and enforces apply for write effects', async (t) => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sentryfrogg-intent-'));
    const previousCapabilities = process.env.MCP_CAPABILITIES_PATH;
    const previousEvidence = process.env.MCP_EVIDENCE_DIR;
    process.env.MCP_CAPABILITIES_PATH = path.join(tmpRoot, 'capabilities.json');
    process.env.MCP_EVIDENCE_DIR = path.join(tmpRoot, 'evidence');
    t.after(async () => {
        if (previousCapabilities === undefined) {
            delete process.env.MCP_CAPABILITIES_PATH;
        }
        else {
            process.env.MCP_CAPABILITIES_PATH = previousCapabilities;
        }
        if (previousEvidence === undefined) {
            delete process.env.MCP_EVIDENCE_DIR;
        }
        else {
            process.env.MCP_EVIDENCE_DIR = previousEvidence;
        }
        await fs.rm(tmpRoot, { recursive: true, force: true });
    });
    const capabilityService = new CapabilityService(loggerStub, securityStub);
    await capabilityService.initialize();
    await capabilityService.setCapability('k8s.apply', {
        intent: 'k8s.apply',
        runbook: 'k8s.apply',
        inputs: { required: ['overlay'] },
        effects: { kind: 'write', requires_apply: true },
    });
    const runbookManagerStub = {
        handleAction: async (args) => ({
            success: true,
            runbook: args.name,
            steps: [],
        }),
    };
    const contextServiceStub = {
        async getContext() {
            return { context: { key: 'demo', root: tmpRoot, tags: ['k8s'] } };
        },
    };
    const evidenceService = new EvidenceService(loggerStub, securityStub);
    const intentManager = new IntentManager(loggerStub, securityStub, validationStub, capabilityService, runbookManagerStub, evidenceService, null, contextServiceStub);
    const compiled = await intentManager.handleAction({
        action: 'compile',
        intent: { type: 'k8s.apply', inputs: { overlay: '/repo/overlay' } },
    });
    assert.equal(compiled.plan.steps.length, 1);
    await assert.rejects(() => intentManager.handleAction({
        action: 'execute',
        intent: { type: 'k8s.apply', inputs: { overlay: '/repo/overlay' } },
    }), (error) => {
        assert.equal(ToolError.isToolError(error), true);
        assert.equal(error.kind, 'denied');
        assert.equal(error.code, 'APPLY_REQUIRED');
        return true;
    });
    const executed = await intentManager.handleAction({
        action: 'execute',
        apply: true,
        save_evidence: true,
        intent: { type: 'k8s.apply', inputs: { overlay: '/repo/overlay' } },
    });
    assert.equal(executed.success, true);
    assert.ok(executed.evidence_path);
});
