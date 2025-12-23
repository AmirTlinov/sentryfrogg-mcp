const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const { dirname, join } = require('node:path');

const PROJECT_ROOT = dirname(__dirname);

function startServer(args = [], envOverrides = {}) {
  const profilesDir = fs.mkdtempSync(join(os.tmpdir(), 'sentryfrogg-mcp-test-'));
  const proc = spawn('node', ['sentryfrogg_server.cjs', ...args], {
    cwd: PROJECT_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      MCP_PROFILES_DIR: profilesDir,
      ...envOverrides,
    },
  });
  proc.__sentryfrogg_profiles_dir = profilesDir;
  return proc;
}

function readLine(stream) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk;
      const idx = buffer.indexOf('\n');
      if (idx !== -1) {
        const line = buffer.slice(0, idx);
        cleanup();
        resolve(line);
      }
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('stream closed before newline'));
    };
    const cleanup = () => {
      stream.off('data', onData);
      stream.off('error', onError);
      stream.off('close', onClose);
    };
    stream.on('data', onData);
    stream.on('error', onError);
    stream.on('close', onClose);
  });
}

async function cleanupProfilesDir(proc) {
  const dir = proc?.__sentryfrogg_profiles_dir;
  if (!dir) {
    return;
  }

  try {
    await fsp.rm(dir, { recursive: true, force: true });
  } catch (error) {
  }
}

function terminate(proc) {
  return new Promise((resolve) => {
    if (proc.exitCode !== null) {
      return resolve();
    }

    const killTimer = setTimeout(() => {
      if (proc.exitCode === null) {
        proc.kill('SIGKILL');
      }
    }, 5000);

    proc.once('exit', () => {
      clearTimeout(killTimer);
      cleanupProfilesDir(proc).finally(resolve);
    });

    proc.kill('SIGTERM');
  });
}

module.exports = {
  PROJECT_ROOT,
  startServer,
  readLine,
  terminate,
};
