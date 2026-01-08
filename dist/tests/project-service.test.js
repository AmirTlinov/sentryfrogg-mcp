"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// @ts-nocheck
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const ProjectService = require('../src/services/ProjectService');
const loggerStub = {
    child() {
        return this;
    },
    info() { },
    warn() { },
    error() { },
};
test('ProjectService persists and lists projects', async (t) => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sentryfrogg-projects-'));
    const previousPath = process.env.MCP_PROJECTS_PATH;
    process.env.MCP_PROJECTS_PATH = path.join(tmpRoot, 'projects.json');
    t.after(async () => {
        if (previousPath === undefined) {
            delete process.env.MCP_PROJECTS_PATH;
        }
        else {
            process.env.MCP_PROJECTS_PATH = previousPath;
        }
        await fs.rm(tmpRoot, { recursive: true, force: true });
    });
    const service = new ProjectService(loggerStub);
    await service.initialize();
    const payload = {
        description: 'Demo project',
        default_target: 'prod',
        targets: {
            prod: {
                ssh_profile: 'demo-prod-ssh',
                env_profile: 'demo-prod-env',
            },
        },
    };
    const saved = await service.setProject('demo', payload);
    assert.equal(saved.success, true);
    assert.equal(saved.project.name, 'demo');
    const fetched = await service.getProject('demo');
    assert.equal(fetched.project.default_target, 'prod');
    assert.equal(fetched.project.targets.prod.ssh_profile, 'demo-prod-ssh');
    const list = await service.listProjects();
    assert.equal(list.projects.length, 1);
    assert.equal(list.projects[0].name, 'demo');
    const removed = await service.deleteProject('demo');
    assert.equal(removed.project, 'demo');
    const listAfter = await service.listProjects();
    assert.equal(listAfter.projects.length, 0);
});
test('ProjectService accepts policy profiles and target policy references', async (t) => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sentryfrogg-projects-'));
    const previousPath = process.env.MCP_PROJECTS_PATH;
    process.env.MCP_PROJECTS_PATH = path.join(tmpRoot, 'projects.json');
    t.after(async () => {
        if (previousPath === undefined) {
            delete process.env.MCP_PROJECTS_PATH;
        }
        else {
            process.env.MCP_PROJECTS_PATH = previousPath;
        }
        await fs.rm(tmpRoot, { recursive: true, force: true });
    });
    const service = new ProjectService(loggerStub);
    await service.initialize();
    const payload = {
        description: 'Policy profile project',
        policy_profiles: {
            autonomy: {
                mode: 'operatorless',
                lock: { enabled: false },
            },
        },
        targets: {
            prod: {
                ssh_profile: 'demo-prod-ssh',
                policy: 'autonomy',
            },
        },
    };
    const saved = await service.setProject('policy-demo', payload);
    assert.equal(saved.success, true);
    const fetched = await service.getProject('policy-demo');
    assert.equal(fetched.project.policy_profiles.autonomy.mode, 'operatorless');
    assert.equal(fetched.project.targets.prod.policy, 'autonomy');
});
