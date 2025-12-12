const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, readLine, terminate } = require('./util.cjs');

const INVALID_INIT = {
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
  },
};

const VALID_INIT = {
  jsonrpc: '2.0',
  id: 10,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'negative-test', version: '1.0.0' },
  },
};

const PING = {
  jsonrpc: '2.0',
  id: 11,
  method: 'ping',
};

function waitForSilence(stream, timeoutMs = 200) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve('');
    }, timeoutMs);

    const onData = (chunk) => {
      cleanup();
      resolve(chunk.toString());
    };

    const cleanup = () => {
      clearTimeout(timer);
      stream.off('data', onData);
    };

    stream.on('data', onData);
  });
}

test('invalid initialize request yields no stdout response', async () => {
  const proc = startServer();
  try {
    proc.stdin.write(JSON.stringify(INVALID_INIT) + '\n');
    const noise = await waitForSilence(proc.stdout, 200);
    assert.equal(noise, '', 'stdout should remain silent for invalid requests');
  } finally {
    await terminate(proc);
  }
});

test('server emits no stdout before receiving initialize', async () => {
  const proc = startServer();
  try {
    const noise = await waitForSilence(proc.stdout, 200);
    assert.equal(noise, '', 'stdout should remain silent before initialize');

    proc.stdin.write(JSON.stringify(VALID_INIT) + '\n');
    const initResp = JSON.parse(await readLine(proc.stdout));
    assert.equal(initResp.result.protocolVersion, '2025-06-18');

    proc.stdin.write(JSON.stringify(PING) + '\n');
    const pingResp = JSON.parse(await readLine(proc.stdout));
    assert.deepEqual(pingResp.result, {});
  } finally {
    await terminate(proc);
  }
});
