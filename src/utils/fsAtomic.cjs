#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function randomToken() {
  return crypto.randomBytes(6).toString('hex');
}

function tempSiblingPath(targetPath, suffix = '.tmp') {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  return path.join(dir, `${base}${suffix}-${process.pid}-${Date.now()}-${randomToken()}`);
}

async function ensureDirForFile(filePath, mode = 0o700) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode });
}

async function chmodQuiet(filePath, mode) {
  if (!mode) {
    return;
  }
  try {
    await fs.chmod(filePath, mode);
  } catch (error) {
    // Best-effort: permissions may not be supported (e.g., Windows) or may fail due to FS policies.
  }
}

async function atomicReplaceFile(tmpPath, targetPath, { overwrite = true, mode } = {}) {
  if (!overwrite && await pathExists(targetPath)) {
    throw new Error(`Path already exists: ${targetPath}`);
  }

  await ensureDirForFile(targetPath);

  const windows = process.platform === 'win32';
  if (!windows) {
    await fs.rename(tmpPath, targetPath);
    await chmodQuiet(targetPath, mode);
    return;
  }

  const backupPath = tempSiblingPath(targetPath, '.bak');
  let backedUp = false;

  if (overwrite && await pathExists(targetPath)) {
    await fs.rename(targetPath, backupPath);
    backedUp = true;
  }

  try {
    await fs.rename(tmpPath, targetPath);
  } catch (error) {
    if ((error.code === 'EEXIST' || error.code === 'EPERM') && overwrite) {
      try {
        await fs.unlink(targetPath);
      } catch (unlinkError) {
        if (unlinkError.code !== 'ENOENT') {
          throw unlinkError;
        }
      }
      await fs.rename(tmpPath, targetPath);
    } else {
      if (backedUp) {
        await fs.rename(backupPath, targetPath).catch(() => null);
      }
      throw error;
    }
  }

  if (backedUp) {
    await fs.unlink(backupPath).catch(() => null);
  }

  await chmodQuiet(targetPath, mode);
}

async function atomicWriteTextFile(filePath, contents, { mode = 0o600 } = {}) {
  const tmpPath = tempSiblingPath(filePath);
  await ensureDirForFile(filePath);

  try {
    await fs.writeFile(tmpPath, contents, { encoding: 'utf8', mode });
    await chmodQuiet(tmpPath, mode);
    await atomicReplaceFile(tmpPath, filePath, { overwrite: true, mode });
  } catch (error) {
    await fs.unlink(tmpPath).catch(() => null);
    throw error;
  }
}

module.exports = {
  atomicReplaceFile,
  atomicWriteTextFile,
  ensureDirForFile,
  pathExists,
  tempSiblingPath,
};

