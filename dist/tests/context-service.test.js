"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// @ts-nocheck
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const ContextService = require('../src/services/ContextService');
const loggerStub = {
    child() {
        return this;
    },
    info() { },
    warn() { },
    error() { },
};
test('ContextService detects markers and caches context', async (t) => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sentryfrogg-context-'));
    const previousContext = process.env.MCP_CONTEXT_PATH;
    process.env.MCP_CONTEXT_PATH = path.join(tmpRoot, 'context.json');
    await fs.writeFile(path.join(tmpRoot, 'package.json'), '{"name":"demo"}');
    await fs.writeFile(path.join(tmpRoot, 'Dockerfile'), 'FROM alpine');
    await fs.mkdir(path.join(tmpRoot, '.git'), { recursive: true });
    await fs.mkdir(path.join(tmpRoot, '.argocd'), { recursive: true });
    await fs.mkdir(path.join(tmpRoot, 'flux-system'), { recursive: true });
    t.after(async () => {
        if (previousContext === undefined) {
            delete process.env.MCP_CONTEXT_PATH;
        }
        else {
            process.env.MCP_CONTEXT_PATH = previousContext;
        }
        await fs.rm(tmpRoot, { recursive: true, force: true });
    });
    const service = new ContextService(loggerStub, null);
    await service.initialize();
    const result = await service.getContext({ cwd: tmpRoot, refresh: true });
    const context = result.context;
    assert.equal(context.root, tmpRoot);
    assert.ok(context.tags.includes('node'));
    assert.ok(context.tags.includes('docker'));
    assert.ok(context.tags.includes('git'));
    assert.ok(context.tags.includes('argocd'));
    assert.ok(context.tags.includes('flux'));
    assert.ok(context.tags.includes('gitops'));
    const list = await service.listContexts();
    assert.equal(list.contexts.length, 1);
});
