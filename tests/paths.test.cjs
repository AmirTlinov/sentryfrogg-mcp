const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { resolveProfileBaseDir } = require('../src/utils/paths.cjs');

test('resolveProfileBaseDir uses MCP_PROFILES_DIR override', async (t) => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sentryfrogg-paths-'));
  const prev = process.env.MCP_PROFILES_DIR;
  const prevLegacy = process.env.MCP_LEGACY_STORE;

  t.after(async () => {
    if (prev === undefined) {
      delete process.env.MCP_PROFILES_DIR;
    } else {
      process.env.MCP_PROFILES_DIR = prev;
    }
    if (prevLegacy === undefined) {
      delete process.env.MCP_LEGACY_STORE;
    } else {
      process.env.MCP_LEGACY_STORE = prevLegacy;
    }
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  process.env.MCP_PROFILES_DIR = tmpRoot;
  assert.equal(resolveProfileBaseDir(), tmpRoot);
});

test('resolveProfileBaseDir prefers legacy store next to entrypoint when MCP_LEGACY_STORE is enabled', async (t) => {
  const legacyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sentryfrogg-legacy-'));
  const xdgDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sentryfrogg-xdg-'));

  const prevProfilesDir = process.env.MCP_PROFILES_DIR;
  const prevXdg = process.env.XDG_STATE_HOME;
  const prevLegacy = process.env.MCP_LEGACY_STORE;
  const prevArgv1 = process.argv[1];

  t.after(async () => {
    if (prevProfilesDir === undefined) {
      delete process.env.MCP_PROFILES_DIR;
    } else {
      process.env.MCP_PROFILES_DIR = prevProfilesDir;
    }

    if (prevXdg === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = prevXdg;
    }

    if (prevLegacy === undefined) {
      delete process.env.MCP_LEGACY_STORE;
    } else {
      process.env.MCP_LEGACY_STORE = prevLegacy;
    }

    process.argv[1] = prevArgv1;

    await fs.rm(legacyDir, { recursive: true, force: true });
    await fs.rm(xdgDir, { recursive: true, force: true });
  });

  delete process.env.MCP_PROFILES_DIR;
  process.env.XDG_STATE_HOME = xdgDir;
  process.env.MCP_LEGACY_STORE = '1';

  process.argv[1] = path.join(legacyDir, 'sentryfrogg_server.cjs');
  await fs.writeFile(path.join(legacyDir, 'profiles.json'), '{}\n', 'utf8');

  assert.equal(resolveProfileBaseDir(), legacyDir);
});

test('resolveProfileBaseDir falls back to XDG state dir when no legacy store', async (t) => {
  const xdgDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sentryfrogg-xdg-state-'));
  const entryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sentryfrogg-entry-'));

  const prevProfilesDir = process.env.MCP_PROFILES_DIR;
  const prevXdg = process.env.XDG_STATE_HOME;
  const prevLegacy = process.env.MCP_LEGACY_STORE;
  const prevArgv1 = process.argv[1];

  t.after(async () => {
    if (prevProfilesDir === undefined) {
      delete process.env.MCP_PROFILES_DIR;
    } else {
      process.env.MCP_PROFILES_DIR = prevProfilesDir;
    }

    if (prevXdg === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = prevXdg;
    }

    if (prevLegacy === undefined) {
      delete process.env.MCP_LEGACY_STORE;
    } else {
      process.env.MCP_LEGACY_STORE = prevLegacy;
    }

    process.argv[1] = prevArgv1;

    await fs.rm(xdgDir, { recursive: true, force: true });
    await fs.rm(entryDir, { recursive: true, force: true });
  });

  delete process.env.MCP_PROFILES_DIR;
  delete process.env.MCP_LEGACY_STORE;
  process.env.XDG_STATE_HOME = xdgDir;
  process.argv[1] = path.join(entryDir, 'sentryfrogg_server.cjs');

  assert.equal(resolveProfileBaseDir(), path.join(xdgDir, 'sentryfrogg'));
});

test('resolveProfileBaseDir uses HOME fallback when XDG_STATE_HOME is unset', async (t) => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sentryfrogg-home-'));
  const entryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sentryfrogg-entry-'));

  const prevProfilesDir = process.env.MCP_PROFILES_DIR;
  const prevXdg = process.env.XDG_STATE_HOME;
  const prevHome = process.env.HOME;
  const prevLegacy = process.env.MCP_LEGACY_STORE;
  const prevArgv1 = process.argv[1];

  t.after(async () => {
    if (prevProfilesDir === undefined) {
      delete process.env.MCP_PROFILES_DIR;
    } else {
      process.env.MCP_PROFILES_DIR = prevProfilesDir;
    }

    if (prevXdg === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = prevXdg;
    }

    if (prevHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = prevHome;
    }

    if (prevLegacy === undefined) {
      delete process.env.MCP_LEGACY_STORE;
    } else {
      process.env.MCP_LEGACY_STORE = prevLegacy;
    }

    process.argv[1] = prevArgv1;

    await fs.rm(homeDir, { recursive: true, force: true });
    await fs.rm(entryDir, { recursive: true, force: true });
  });

  delete process.env.MCP_PROFILES_DIR;
  delete process.env.XDG_STATE_HOME;
  delete process.env.MCP_LEGACY_STORE;
  process.env.HOME = homeDir;
  process.argv[1] = path.join(entryDir, 'sentryfrogg_server.cjs');

  assert.equal(resolveProfileBaseDir(), path.join(homeDir, '.local', 'state', 'sentryfrogg'));
});
