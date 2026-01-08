"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// @ts-nocheck
const fs = require('node:fs');
const path = require('node:path');
const dir = __dirname;
for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith('.test.js')) {
        continue;
    }
    require(path.join(dir, entry));
}
