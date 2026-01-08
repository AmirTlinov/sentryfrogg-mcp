#!/usr/bin/env node
"use strict";
// @ts-nocheck
Object.defineProperty(exports, "__esModule", { value: true });
const os = require('os');
const path = require('path');
function resolveHomeDir() {
    const homeFromEnv = process.env.HOME;
    if (homeFromEnv && typeof homeFromEnv === 'string' && homeFromEnv.trim().length > 0) {
        return homeFromEnv;
    }
    try {
        const home = os.homedir();
        return home && typeof home === 'string' ? home : null;
    }
    catch (error) {
        return null;
    }
}
function expandHomePath(value) {
    if (value === null || value === undefined) {
        return value;
    }
    const raw = String(value);
    if (raw === '~') {
        return resolveHomeDir() || raw;
    }
    if (raw.startsWith('~/') || raw.startsWith('~\\')) {
        const home = resolveHomeDir();
        if (!home) {
            return raw;
        }
        return path.join(home, raw.slice(2));
    }
    return raw;
}
module.exports = {
    expandHomePath,
};
