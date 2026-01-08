"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// @ts-nocheck
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { resolveProfileBaseDir } = require('../src/utils/paths');
test('resolveProfileBaseDir uses MCP_PROFILES_DIR override', async (t) => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sentryfrogg-paths-'));
    const prev = process.env.MCP_PROFILES_DIR;
    t.after(async () => {
        if (prev === undefined) {
            delete process.env.MCP_PROFILES_DIR;
        }
        else {
            process.env.MCP_PROFILES_DIR = prev;
        }
        await fs.rm(tmpRoot, { recursive: true, force: true });
    });
    process.env.MCP_PROFILES_DIR = tmpRoot;
    assert.equal(resolveProfileBaseDir(), tmpRoot);
});
test('resolveProfileBaseDir uses XDG state dir when set', async (t) => {
    const xdgDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sentryfrogg-xdg-state-'));
    const prevProfilesDir = process.env.MCP_PROFILES_DIR;
    const prevXdg = process.env.XDG_STATE_HOME;
    t.after(async () => {
        if (prevProfilesDir === undefined) {
            delete process.env.MCP_PROFILES_DIR;
        }
        else {
            process.env.MCP_PROFILES_DIR = prevProfilesDir;
        }
        if (prevXdg === undefined) {
            delete process.env.XDG_STATE_HOME;
        }
        else {
            process.env.XDG_STATE_HOME = prevXdg;
        }
        await fs.rm(xdgDir, { recursive: true, force: true });
    });
    delete process.env.MCP_PROFILES_DIR;
    process.env.XDG_STATE_HOME = xdgDir;
    assert.equal(resolveProfileBaseDir(), path.join(xdgDir, 'sentryfrogg'));
});
test('resolveProfileBaseDir uses HOME fallback when XDG_STATE_HOME is unset', async (t) => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sentryfrogg-home-'));
    const prevProfilesDir = process.env.MCP_PROFILES_DIR;
    const prevXdg = process.env.XDG_STATE_HOME;
    const prevHome = process.env.HOME;
    t.after(async () => {
        if (prevProfilesDir === undefined) {
            delete process.env.MCP_PROFILES_DIR;
        }
        else {
            process.env.MCP_PROFILES_DIR = prevProfilesDir;
        }
        if (prevXdg === undefined) {
            delete process.env.XDG_STATE_HOME;
        }
        else {
            process.env.XDG_STATE_HOME = prevXdg;
        }
        if (prevHome === undefined) {
            delete process.env.HOME;
        }
        else {
            process.env.HOME = prevHome;
        }
        await fs.rm(homeDir, { recursive: true, force: true });
    });
    delete process.env.MCP_PROFILES_DIR;
    delete process.env.XDG_STATE_HOME;
    process.env.HOME = homeDir;
    assert.equal(resolveProfileBaseDir(), path.join(homeDir, '.local', 'state', 'sentryfrogg'));
});
