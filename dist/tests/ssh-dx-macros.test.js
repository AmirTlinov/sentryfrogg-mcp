"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// @ts-nocheck
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const SSHManager = require('../src/managers/SSHManager');
const loggerStub = {
    child() {
        return this;
    },
    info() { },
    warn() { },
    error() { },
};
const validationStub = {
    ensurePort(value, fallback) {
        return value ?? fallback;
    },
    ensureString(value) {
        return String(value);
    },
};
const securityStub = {
    cleanCommand(value) {
        return value;
    },
};
async function writeTempFile(text) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sentryfrogg-macro-'));
    const filePath = path.join(dir, 'payload.txt');
    await fs.writeFile(filePath, text, 'utf8');
    return { dir, filePath };
}
test('ssh.deploy_file verifies sha256 and can restart service', async () => {
    const payload = 'hello\n';
    const expected = crypto.createHash('sha256').update(payload).digest('hex');
    const { dir, filePath } = await writeTempFile(payload);
    try {
        const manager = new SSHManager(loggerStub, securityStub, validationStub, null, null, null);
        let uploadArgs = null;
        manager.sftpUpload = async (args) => {
            uploadArgs = args;
            return { success: true, local_path: args.local_path, remote_path: args.remote_path };
        };
        manager.execCommand = async (args) => {
            const command = String(args.command || '');
            if (command.includes('sha256sum') || command.includes('shasum') || command.includes('openssl dgst')) {
                return { stdout: `${expected}  ${args.remote_path || ''}\n`, stderr: '', exitCode: 0, signal: null, timedOut: false, hardTimedOut: false, duration_ms: 1 };
            }
            if (command.includes('systemctl restart')) {
                return { stdout: 'active\n', stderr: '', exitCode: 0, signal: null, timedOut: false, hardTimedOut: false, duration_ms: 1 };
            }
            return { stdout: '', stderr: '', exitCode: 0, signal: null, timedOut: false, hardTimedOut: false, duration_ms: 1 };
        };
        const result = await manager.handleAction({
            action: 'deploy_file',
            local_path: filePath,
            remote_path: '/opt/app/payload.txt',
            restart: 'myapp',
        });
        assert.equal(result.success, true);
        assert.equal(result.verified, true);
        assert.equal(result.local_sha256, expected);
        assert.equal(result.remote_sha256, expected);
        assert.equal(uploadArgs.overwrite, true);
        assert.equal(result.restart.requested, true);
        assert.equal(result.restart.exit_code, 0);
    }
    finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});
test('ssh.deploy_file reports hash mismatch', async () => {
    const payload = 'hello\n';
    const expected = crypto.createHash('sha256').update(payload).digest('hex');
    const { dir, filePath } = await writeTempFile(payload);
    try {
        const manager = new SSHManager(loggerStub, securityStub, validationStub, null, null, null);
        manager.sftpUpload = async () => ({ success: true });
        manager.execCommand = async () => {
            const other = 'b'.repeat(64);
            return { stdout: `${other}\n`, stderr: '', exitCode: 0, signal: null, timedOut: false, hardTimedOut: false, duration_ms: 1 };
        };
        const result = await manager.handleAction({
            action: 'deploy_file',
            local_path: filePath,
            remote_path: '/opt/app/payload.txt',
        });
        assert.equal(result.success, false);
        assert.equal(result.code, 'HASH_MISMATCH');
        assert.equal(result.local_sha256, expected);
    }
    finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});
test('ssh.tail_job combines status and logs in one call', async () => {
    const manager = new SSHManager(loggerStub, securityStub, validationStub, null, null, null);
    manager.jobStatus = async () => ({ success: true, job_id: 'job-1', running: true, exited: false, exit_code: null });
    manager.jobLogsTail = async () => ({ success: true, job_id: 'job-1', log_path: '/tmp/job.log', lines: 5, text: 'hello\n' });
    const result = await manager.handleAction({ action: 'tail_job', job_id: 'job-1', lines: 5 });
    assert.equal(result.success, true);
    assert.equal(result.job_id, 'job-1');
    assert.equal(result.status.running, true);
    assert.equal(result.logs.text, 'hello\n');
});
test('ssh.follow_job waits and tails logs in one call', async () => {
    const manager = new SSHManager(loggerStub, securityStub, validationStub, null, null, null);
    manager.jobWait = async () => ({
        success: true,
        completed: true,
        timed_out: false,
        waited_ms: 1,
        timeout_ms: 1000,
        poll_interval_ms: 1,
        status: { success: true, job_id: 'job-1', running: false, exited: true, exit_code: 0 },
    });
    manager.jobLogsTail = async () => ({ success: true, job_id: 'job-1', log_path: '/tmp/job.log', lines: 5, text: 'hello\n' });
    const result = await manager.handleAction({ action: 'follow_job', job_id: 'job-1', lines: 5, timeout_ms: 1000 });
    assert.equal(result.success, true);
    assert.equal(result.job_id, 'job-1');
    assert.equal(result.wait.completed, true);
    assert.equal(result.status.exited, true);
    assert.equal(result.logs.text, 'hello\n');
});
test('ssh.exec_follow starts detached job and returns wait+logs', async () => {
    const manager = new SSHManager(loggerStub, securityStub, validationStub, null, null, null);
    manager.execDetached = async () => ({
        success: true,
        job_id: 'job-1',
        pid: 4242,
        log_path: '/tmp/job.log',
        pid_path: '/tmp/job.log.pid',
        exit_path: '/tmp/job.log.exit',
        start_timeout_ms: 500,
    });
    manager.followJob = async () => ({
        success: true,
        job_id: 'job-1',
        wait: { completed: true, timed_out: false, waited_ms: 1, timeout_ms: 1000 },
        status: { success: true, job_id: 'job-1', running: false, exited: true, exit_code: 0 },
        logs: { success: true, job_id: 'job-1', lines: 5, text: 'hello\n' },
    });
    const result = await manager.handleAction({ action: 'exec_follow', command: 'echo ok', timeout_ms: 1000, lines: 5 });
    assert.equal(result.success, true);
    assert.equal(result.job_id, 'job-1');
    assert.equal(result.start.pid, 4242);
    assert.equal(result.status.exit_code, 0);
    assert.equal(result.logs.text, 'hello\n');
});
test('ssh.exec auto-switches to exec_follow when timeout exceeds tool-call budget', async () => {
    const manager = new SSHManager(loggerStub, securityStub, validationStub, null, null, null);
    manager.resolveToolCallBudgetMs = () => 1000;
    manager.resolveConnection = async () => ({ connection: {}, profileName: null });
    manager.buildCommand = (cmd) => String(cmd);
    let followArgs = null;
    manager.execFollow = async (args) => {
        followArgs = args;
        return {
            success: true,
            job_id: 'job-1',
            start: { success: true, pid: 1 },
            wait: { completed: false, timed_out: true, waited_ms: 1000, timeout_ms: 1000 },
            status: { success: true, job_id: 'job-1', running: true, exited: false, exit_code: null },
            logs: { success: true, job_id: 'job-1', lines: 5, text: 'still running\n' },
        };
    };
    const result = await manager.handleAction({ action: 'exec', command: 'sleep 60', timeout_ms: 60_000, lines: 5 });
    assert.equal(result.detached, true);
    assert.equal(result.requested_timeout_ms, 60_000);
    assert.ok(followArgs);
    assert.equal(followArgs.timeout_ms, 60_000);
    assert.equal(result.job_id, 'job-1');
    assert.equal(result.success, true);
});
