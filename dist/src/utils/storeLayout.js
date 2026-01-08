#!/usr/bin/env node
"use strict";
// @ts-nocheck
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * 📦 Store layout helpers.
 */
const path = require('path');
const STORE_ITEMS = [
    { key: 'profiles', relative: 'profiles.json', kind: 'file', sensitive: true },
    { key: 'projects', relative: 'projects.json', kind: 'file', sensitive: true },
    { key: 'runbooks', relative: 'runbooks.json', kind: 'file', sensitive: false },
    { key: 'capabilities', relative: 'capabilities.json', kind: 'file', sensitive: false },
    { key: 'context', relative: 'context.json', kind: 'file', sensitive: true },
    { key: 'aliases', relative: 'aliases.json', kind: 'file', sensitive: true },
    { key: 'presets', relative: 'presets.json', kind: 'file', sensitive: true },
    { key: 'audit', relative: 'audit.jsonl', kind: 'file', sensitive: true },
    { key: 'state', relative: 'state.json', kind: 'file', sensitive: true },
    { key: 'key', relative: '.mcp_profiles.key', kind: 'file', sensitive: true },
    { key: 'cache', relative: 'cache', kind: 'dir', sensitive: true },
    { key: 'evidence', relative: path.join('.sentryfrogg', 'evidence'), kind: 'dir', sensitive: true },
];
function buildStorePaths(baseDir) {
    if (!baseDir) {
        return [];
    }
    return STORE_ITEMS.map((item) => ({
        ...item,
        path: path.join(baseDir, item.relative),
    }));
}
module.exports = {
    STORE_ITEMS,
    buildStorePaths,
};
