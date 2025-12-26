const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const WorkspaceService = require('../src/services/WorkspaceService.cjs');

const loggerStub = {
  child() {
    return this;
  },
  info() {},
  warn() {},
  error() {},
};

test('WorkspaceService summary returns suggestions', async (t) => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sentryfrogg-workspace-'));
  const prevProfilesDir = process.env.MCP_PROFILES_DIR;
  const prevLegacy = process.env.MCP_LEGACY_STORE;

  t.after(async () => {
    if (prevProfilesDir === undefined) {
      delete process.env.MCP_PROFILES_DIR;
    } else {
      process.env.MCP_PROFILES_DIR = prevProfilesDir;
    }
    if (prevLegacy === undefined) {
      delete process.env.MCP_LEGACY_STORE;
    } else {
      process.env.MCP_LEGACY_STORE = prevLegacy;
    }
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  process.env.MCP_PROFILES_DIR = tmpRoot;
  delete process.env.MCP_LEGACY_STORE;

  const contextService = {
    async getContext() {
      return {
        context: {
          key: 'ctx',
          root: tmpRoot,
          tags: ['k8s', 'git'],
          project_name: 'demo',
          target_name: 'prod',
          updated_at: new Date().toISOString(),
        },
      };
    },
  };

  const projectResolver = {
    async resolveContext() {
      return {
        projectName: 'demo',
        targetName: 'prod',
        project: { description: 'Demo project', repo_root: tmpRoot },
        target: { ssh_profile: 'demo-ssh' },
      };
    },
  };

  const profileService = {
    async listProfiles() {
      return [{ name: 'demo-ssh', type: 'ssh', data: {} }];
    },
    hasProfile() {
      return true;
    },
  };

  const runbookService = {
    async listRunbooks() {
      return {
        success: true,
        runbooks: [
          { name: 'k8s.diff', tags: ['k8s'], description: 'Diff', source: 'default' },
        ],
      };
    },
  };

  const capabilityService = {
    async listCapabilities() {
      return [
        {
          name: 'k8s.diff',
          intent: 'k8s.diff',
          when: { tags_any: ['k8s'] },
          tags: ['k8s'],
          effects: { kind: 'read' },
          source: 'default',
        },
      ];
    },
  };

  const projectService = {
    async listProjects() {
      return { success: true, projects: [] };
    },
  };

  const aliasService = {
    getStats() {
      return { total: 0 };
    },
  };

  const presetService = {
    getStats() {
      return { total: 0 };
    },
  };

  const stateService = {
    getStats() {
      return { session_keys: 0, persistent_keys: 0 };
    },
  };

  const workspace = new WorkspaceService(
    loggerStub,
    contextService,
    null,
    projectResolver,
    profileService,
    runbookService,
    capabilityService,
    projectService,
    aliasService,
    presetService,
    stateService
  );

  const result = await workspace.summarize({});
  assert.equal(result.success, true);
  assert.ok(result.workspace.suggestions.capabilities.some((item) => item.name === 'k8s.diff'));
  assert.ok(result.workspace.suggestions.runbooks.some((item) => item.name === 'k8s.diff'));
  assert.ok(result.workspace.actions.intents.some((item) => item.intent === 'k8s.diff'));

  const actionsOnly = await workspace.summarize({ format: 'actions' });
  assert.equal(actionsOnly.success, true);
  assert.ok(actionsOnly.actions.intents.some((item) => item.intent === 'k8s.diff'));
});
