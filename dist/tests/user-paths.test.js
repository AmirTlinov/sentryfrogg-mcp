"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// @ts-nocheck
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { expandHomePath } = require('../src/utils/userPaths');
test('expandHomePath expands ~ and leaves other paths intact', async () => {
    const previousHome = process.env.HOME;
    try {
        process.env.HOME = path.join(path.sep, 'tmp', 'sentryfrogg-home');
        assert.equal(expandHomePath('~'), process.env.HOME);
        assert.equal(expandHomePath('~/id_ed25519'), path.join(process.env.HOME, 'id_ed25519'));
        assert.equal(expandHomePath('/var/tmp/file'), '/var/tmp/file');
        assert.equal(expandHomePath('relative/file'), 'relative/file');
        assert.equal(expandHomePath('~someone/file'), '~someone/file');
    }
    finally {
        if (previousHome === undefined) {
            delete process.env.HOME;
        }
        else {
            process.env.HOME = previousHome;
        }
    }
});
