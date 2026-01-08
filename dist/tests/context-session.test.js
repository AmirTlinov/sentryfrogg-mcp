"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// @ts-nocheck
const test = require('node:test');
const assert = require('node:assert/strict');
const ContextSessionService = require('../src/services/ContextSessionService');
const loggerStub = {
    child() {
        return this;
    },
    info() { },
    warn() { },
    error() { },
};
test('ContextSessionService enriches tags and reports diagnostics', async () => {
    const contextService = {
        async getContext() {
            return {
                context: {
                    key: 'ctx',
                    root: '/tmp/demo',
                    tags: ['git'],
                },
            };
        },
    };
    const projectResolver = {
        async resolveContext() {
            return {
                projectName: 'demo',
                targetName: 'prod',
                project: { repo_root: '/tmp/demo' },
                target: { kubeconfig: '/tmp/missing-kubeconfig', ssh_profile: 'demo-ssh' },
            };
        },
    };
    const profileService = {
        hasProfile() {
            return true;
        },
        async probeProfileSecrets() {
            return { ok: false, encrypted: true, error: 'decrypt failed' };
        },
    };
    const service = new ContextSessionService(loggerStub, contextService, projectResolver, profileService);
    const session = await service.resolve({});
    assert.ok(session.effective_context.tags.includes('k8s'));
    assert.ok(session.effective_context.tags.includes('ssh'));
    assert.ok(session.diagnostics.warnings.some((entry) => entry.code === 'path_missing'));
    assert.ok(session.diagnostics.warnings.some((entry) => entry.code === 'profile_secrets_unreadable'));
});
