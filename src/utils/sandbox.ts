#!/usr/bin/env node
// @ts-nocheck

const fs = require('node:fs/promises');
const path = require('node:path');

function ensureInsideRoot(root, candidate) {
  if (candidate === root) {
    return;
  }
  if (!candidate.startsWith(`${root}${path.sep}`)) {
    throw new Error('Path escapes sandbox root');
  }
}

async function resolveSandboxPath(rootDir, candidatePath, options = {}) {
  if (typeof rootDir !== 'string' || rootDir.trim().length === 0) {
    throw new Error('rootDir must be a non-empty string');
  }

  const mustExist = options.mustExist !== false;
  const rootReal = await fs.realpath(rootDir);

  if (!candidatePath) {
    return rootReal;
  }

  const resolved = path.resolve(rootReal, String(candidatePath));
  ensureInsideRoot(rootReal, resolved);

  if (mustExist) {
    const real = await fs.realpath(resolved);
    ensureInsideRoot(rootReal, real);
    return real;
  }

  const parent = path.dirname(resolved);
  const parentReal = await fs.realpath(parent);
  ensureInsideRoot(rootReal, parentReal);
  const final = path.join(parentReal, path.basename(resolved));
  ensureInsideRoot(rootReal, final);
  return final;
}

module.exports = {
  resolveSandboxPath,
};
