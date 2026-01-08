"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// @ts-nocheck
const test = require('node:test');
const assert = require('node:assert/strict');
const RunbookManager = require('../src/managers/RunbookManager');
const loggerStub = {
    child() {
        return this;
    },
    warn() { },
    info() { },
    error() { },
};
const stateServiceStub = () => ({
    state: {},
    async set(key, value) {
        this.state[key] = value;
    },
    async dump() {
        return { state: { ...this.state } };
    },
});
const runbookServiceStub = () => ({
    async getRunbook() {
        throw new Error('not used');
    },
    async setRunbook() { },
    async listRunbooks() {
        return { success: true, runbooks: [] };
    },
    async deleteRunbook() { },
});
test('RunbookManager resolves templates, foreach, and when clauses', async () => {
    const toolExecutor = {
        async execute(tool, args) {
            return { result: { tool, args }, meta: { tool } };
        },
    };
    const manager = new RunbookManager(loggerStub, runbookServiceStub(), stateServiceStub(), toolExecutor);
    const runbook = {
        steps: [
            {
                id: 'ping',
                tool: 'mcp_api_client',
                args: { action: 'request', url: 'https://{{input.host}}/{{input.path}}' },
            },
            {
                id: 'loop',
                tool: 'mcp_api_client',
                foreach: { items: '{{input.ids}}' },
                args: { action: 'request', query: { id: '{{item}}' } },
            },
            {
                id: 'skipme',
                tool: 'mcp_api_client',
                when: { path: 'input.enabled', equals: true },
                args: { action: 'request', url: 'https://{{input.host}}/skip' },
            },
        ],
    };
    const result = await manager.runbookRun({
        runbook,
        input: { host: 'example.com', path: 'health', ids: [1, 2], enabled: false },
    });
    assert.equal(result.success, true);
    assert.equal(result.steps[0].result.args.url, 'https://example.com/health');
    assert.equal(result.steps[1].result.length, 2);
    assert.equal(result.steps[1].result[0].args.query.id, 1);
    assert.equal(result.steps[1].result[1].args.query.id, 2);
    assert.equal(result.steps[2].skipped, true);
});
