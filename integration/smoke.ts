#!/usr/bin/env node
// @ts-nocheck

const { setTimeout: delay } = require('timers/promises');
const { Client: PgClient } = require('pg');
const { Client: SSHClient } = require('ssh2');

const PG_URI = process.env.SF_PG_URI || 'postgresql://mcp_user:mcp_pass@127.0.0.1:5432/mcp_demo';
const SSH_HOST = process.env.SF_SSH_HOST || '127.0.0.1';
const SSH_PORT = Number.parseInt(process.env.SF_SSH_PORT || '2222', 10);
const SSH_USER = process.env.SF_SSH_USER || 'mcp';
const SSH_PASSWORD = process.env.SF_SSH_PASSWORD || 'mcp_pass';

async function retry(label, attempts, task, backoffMs = 2000) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        process.stderr.write(
          `[smoke] ${label} attempt ${attempt} failed: ${error.message}. Retrying in ${backoffMs}ms\n`
        );
        await delay(backoffMs);
      }
    }
  }
  throw lastError;
}

async function checkPostgres() {
  return retry('postgres', 15, async () => {
    const client = new PgClient({ connectionString: PG_URI });
    await client.connect();
    try {
      const res = await client.query('SELECT current_database() AS db, current_user AS usr, 1 AS ok');
      const row = res.rows[0];
      if (!row || row.ok !== 1) {
        throw new Error('Unexpected response from PostgreSQL');
      }
      process.stdout.write(`[smoke] PostgreSQL ready (db=${row.db}, user=${row.usr})\n`);
    } finally {
      await client.end();
    }
  });
}

async function execSSH(command) {
  return new Promise((resolve, reject) => {
    const client = new SSHClient();
    client
      .on('ready', () => {
        client.exec(command, (err, stream) => {
          if (err) {
            client.end();
            reject(err);
            return;
          }

          let stdout = '';
          let stderr = '';

          stream
            .on('close', (code) => {
              client.end();
              if (code === 0) {
                resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
              } else {
                reject(new Error(`SSH command exited with code ${code}: ${stderr.trim()}`));
              }
            })
            .on('data', (data) => {
              stdout += data.toString();
            });

          stream.stderr.on('data', (data) => {
            stderr += data.toString();
          });
        });
      })
      .on('error', reject)
      .connect({
        host: SSH_HOST,
        port: SSH_PORT,
        username: SSH_USER,
        password: SSH_PASSWORD,
        readyTimeout: 10000,
      });
  });
}

async function checkSsh() {
  await retry('ssh', 15, async () => {
    const result = await execSSH('printf "integration:%s\n" "$(uname -s)"');
    if (!result.stdout.startsWith('integration:')) {
      throw new Error('Unexpected SSH response');
    }
    process.stdout.write(`[smoke] SSH ready (${result.stdout})\n`);
  });
}

async function main() {
  await checkPostgres();
  await checkSsh();
  process.stdout.write('[smoke] Integration targets healthy\n');
}

main().catch((error) => {
  process.stderr.write(`[smoke] FAILED: ${error.stack || error.message}\n`);
  process.exitCode = 1;
});
