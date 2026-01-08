#!/usr/bin/env node
"use strict";
// @ts-nocheck
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * ⚠️ Local manager (UNSAFE).
 *
 * Provides local command execution and filesystem helpers.
 * Disabled by default. Enable explicitly via:
 * - SENTRYFROGG_UNSAFE_LOCAL=1 (preferred)
 * - SF_UNSAFE_LOCAL=1
 */
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const { createWriteStream } = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { atomicReplaceFile, ensureDirForFile, pathExists, tempSiblingPath } = require('../utils/fsAtomic');
const { isUnsafeLocalEnabled } = require('../utils/featureFlags');
const { expandHomePath } = require('../utils/userPaths');
function buildTempDir() {
    return path.join(os.tmpdir(), `sentryfrogg-local-${process.pid}`);
}
function randomToken() {
    return crypto.randomBytes(6).toString('hex');
}
class LocalManager {
    constructor(logger, validation, options = {}) {
        this.logger = logger.child('local');
        this.validation = validation;
        this.enabled = options.enabled ?? isUnsafeLocalEnabled();
        this.stats = {
            exec: 0,
            fs_ops: 0,
            errors: 0,
        };
    }
    ensureEnabled() {
        if (!this.enabled) {
            throw new Error('Unsafe local tool is disabled. Set SENTRYFROGG_UNSAFE_LOCAL=1 to enable it.');
        }
    }
    async handleAction(args = {}) {
        this.ensureEnabled();
        const { action } = args;
        switch (action) {
            case 'exec':
                return this.exec(args);
            case 'batch':
                return this.batch(args);
            case 'fs_read':
                return this.fsRead(args);
            case 'fs_write':
                return this.fsWrite(args);
            case 'fs_list':
                return this.fsList(args);
            case 'fs_stat':
                return this.fsStat(args);
            case 'fs_mkdir':
                return this.fsMkdir(args);
            case 'fs_rm':
                return this.fsRm(args);
            default:
                throw new Error(`Unknown local action: ${action}`);
        }
    }
    normalizeEnv(env) {
        if (env === undefined || env === null) {
            return undefined;
        }
        if (typeof env !== 'object' || Array.isArray(env)) {
            throw new Error('env must be an object');
        }
        return Object.fromEntries(Object.entries(env).flatMap(([key, value]) => {
            if (!key || typeof key !== 'string') {
                return [];
            }
            if (value === undefined || value === null) {
                return [];
            }
            return [[key, String(value)]];
        }));
    }
    async exec(args) {
        const command = this.validation.ensureString(args.command, 'command', { trim: false });
        const argv = Array.isArray(args.args) ? args.args.map((item) => String(item)) : null;
        const cwd = args.cwd ? this.validation.ensureString(args.cwd, 'cwd', { trim: false }) : undefined;
        const timeoutMs = args.timeout_ms;
        const stdin = args.stdin;
        const inline = args.inline === true;
        const shell = args.shell !== undefined
            ? args.shell
            : !argv;
        const env = {
            ...process.env,
            ...(this.normalizeEnv(args.env) || {}),
        };
        const started = Date.now();
        const tempDir = buildTempDir();
        await fs.mkdir(tempDir, { recursive: true, mode: 0o700 });
        const token = `${Date.now()}-${randomToken()}`;
        const stdoutPath = path.join(tempDir, `stdout-${token}.log`);
        const stderrPath = path.join(tempDir, `stderr-${token}.log`);
        const stdoutStream = createWriteStream(stdoutPath, { mode: 0o600 });
        const stderrStream = createWriteStream(stderrPath, { mode: 0o600 });
        const stdoutClosed = once(stdoutStream, 'close');
        const stderrClosed = once(stderrStream, 'close');
        return new Promise((resolve, reject) => {
            let finished = false;
            let timedOut = false;
            const child = argv
                ? spawn(command, argv, { cwd, env, shell: false })
                : spawn(command, { cwd, env, shell: shell === true ? true : shell });
            let timeout;
            if (timeoutMs) {
                timeout = setTimeout(() => {
                    timedOut = true;
                    try {
                        child.kill('SIGKILL');
                    }
                    catch (error) {
                    }
                }, timeoutMs);
            }
            const finalize = async (result) => {
                if (finished) {
                    return;
                }
                finished = true;
                if (timeout) {
                    clearTimeout(timeout);
                }
                stdoutStream.end();
                stderrStream.end();
                await Promise.allSettled([stdoutClosed, stderrClosed]);
                const outStat = await fs.stat(stdoutPath).catch(() => null);
                const errStat = await fs.stat(stderrPath).catch(() => null);
                const payload = {
                    success: result.exit_code === 0,
                    command,
                    args: argv || undefined,
                    cwd,
                    exit_code: result.exit_code,
                    signal: result.signal,
                    timed_out: timedOut,
                    duration_ms: Date.now() - started,
                    stdout_path: stdoutPath,
                    stderr_path: stderrPath,
                    stdout_bytes: outStat?.size ?? 0,
                    stderr_bytes: errStat?.size ?? 0,
                };
                if (inline) {
                    const stdout = await fs.readFile(stdoutPath, 'utf8').catch(() => '');
                    const stderr = await fs.readFile(stderrPath, 'utf8').catch(() => '');
                    payload.stdout = stdout.trimEnd();
                    payload.stderr = stderr.trimEnd();
                }
                this.stats.exec += 1;
                resolve(payload);
            };
            child.on('error', async (error) => {
                this.stats.errors += 1;
                if (timeout) {
                    clearTimeout(timeout);
                }
                stdoutStream.end();
                stderrStream.end();
                await Promise.allSettled([stdoutClosed, stderrClosed]);
                await fs.unlink(stdoutPath).catch(() => null);
                await fs.unlink(stderrPath).catch(() => null);
                reject(error);
            });
            child.on('close', (code, signal) => {
                finalize({ exit_code: typeof code === 'number' ? code : 1, signal }).catch(reject);
            });
            if (child.stdout) {
                child.stdout.pipe(stdoutStream);
            }
            if (child.stderr) {
                child.stderr.pipe(stderrStream);
            }
            if (stdin !== undefined && stdin !== null) {
                child.stdin?.end(String(stdin));
            }
            else {
                child.stdin?.end();
            }
        });
    }
    async batch(args) {
        const commands = Array.isArray(args.commands) ? args.commands : [];
        if (commands.length === 0) {
            throw new Error('commands must be a non-empty array');
        }
        const parallel = !!args.parallel;
        const stopOnError = args.stop_on_error !== false;
        if (parallel) {
            const results = await Promise.all(commands.map((command) => this.exec({ ...args, ...command })));
            return { success: results.every((item) => item.exit_code === 0), results };
        }
        const results = [];
        for (const command of commands) {
            try {
                const result = await this.exec({ ...args, ...command });
                results.push(result);
                if (stopOnError && result.exit_code !== 0) {
                    break;
                }
            }
            catch (error) {
                results.push({ success: false, command: command.command, error: error.message });
                if (stopOnError) {
                    break;
                }
            }
        }
        return { success: results.every((item) => item.exit_code === 0), results };
    }
    async fsRead(args) {
        const filePath = expandHomePath(this.validation.ensureString(args.path, 'path', { trim: false }));
        const encoding = args.encoding ? String(args.encoding).toLowerCase() : 'utf8';
        const offset = Number.isInteger(args.offset) ? Math.max(0, args.offset) : 0;
        const length = Number.isInteger(args.length) ? Math.max(0, args.length) : null;
        let data;
        if (offset || length !== null) {
            const handle = await fs.open(filePath, 'r');
            try {
                const stat = await handle.stat();
                const maxLen = length === null ? stat.size - offset : length;
                const buffer = Buffer.alloc(Math.max(0, maxLen));
                const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
                data = buffer.subarray(0, bytesRead);
            }
            finally {
                await handle.close();
            }
        }
        else {
            data = await fs.readFile(filePath);
        }
        this.stats.fs_ops += 1;
        if (encoding === 'base64') {
            return {
                success: true,
                path: filePath,
                encoding: 'base64',
                offset,
                length: length ?? undefined,
                bytes: data.length,
                content: data.toString('base64'),
            };
        }
        return {
            success: true,
            path: filePath,
            encoding: 'utf8',
            offset,
            length: length ?? undefined,
            bytes: data.length,
            content: data.toString('utf8'),
        };
    }
    async fsWrite(args) {
        const filePath = expandHomePath(this.validation.ensureString(args.path, 'path', { trim: false }));
        const overwrite = args.overwrite === true;
        if (!overwrite && await pathExists(filePath)) {
            throw new Error(`Local path already exists: ${filePath}`);
        }
        const mode = args.mode !== undefined ? Number(args.mode) : 0o600;
        const encoding = args.encoding ? String(args.encoding).toLowerCase() : 'utf8';
        const tmpPath = tempSiblingPath(filePath, '.part');
        try {
            await ensureDirForFile(filePath, 0o700);
            if (args.content_base64 !== undefined && args.content_base64 !== null) {
                const buffer = Buffer.from(String(args.content_base64), 'base64');
                await fs.writeFile(tmpPath, buffer, { mode });
            }
            else if (args.content !== undefined && args.content !== null) {
                if (encoding === 'base64') {
                    const buffer = Buffer.from(String(args.content), 'base64');
                    await fs.writeFile(tmpPath, buffer, { mode });
                }
                else {
                    await fs.writeFile(tmpPath, String(args.content), { encoding: 'utf8', mode });
                }
            }
            else {
                throw new Error('content or content_base64 is required');
            }
            await atomicReplaceFile(tmpPath, filePath, { overwrite, mode });
            this.stats.fs_ops += 1;
            return { success: true, path: filePath, bytes_written: (await fs.stat(filePath)).size };
        }
        catch (error) {
            await fs.unlink(tmpPath).catch(() => null);
            this.stats.errors += 1;
            throw error;
        }
    }
    async fsList(args) {
        const root = args.path ? expandHomePath(this.validation.ensureString(args.path, 'path', { trim: false })) : '.';
        const recursive = args.recursive === true;
        const maxDepth = Number.isInteger(args.max_depth) ? Math.max(0, args.max_depth) : 3;
        const withStats = args.with_stats === true;
        const entries = [];
        const walk = async (currentPath, depth) => {
            const list = await fs.readdir(currentPath, { withFileTypes: true });
            for (const entry of list) {
                const fullPath = path.join(currentPath, entry.name);
                const item = {
                    path: fullPath,
                    name: entry.name,
                    type: entry.isDirectory()
                        ? 'dir'
                        : entry.isFile()
                            ? 'file'
                            : entry.isSymbolicLink()
                                ? 'link'
                                : 'other',
                };
                if (withStats) {
                    const stat = await fs.lstat(fullPath).catch(() => null);
                    if (stat) {
                        item.size = stat.size;
                        item.mtime_ms = stat.mtimeMs;
                    }
                }
                entries.push(item);
                if (recursive && entry.isDirectory() && depth < maxDepth) {
                    await walk(fullPath, depth + 1);
                }
            }
        };
        await walk(root, 0);
        this.stats.fs_ops += 1;
        return { success: true, path: root, entries };
    }
    async fsStat(args) {
        const target = expandHomePath(this.validation.ensureString(args.path, 'path', { trim: false }));
        const stat = await fs.lstat(target);
        this.stats.fs_ops += 1;
        return {
            success: true,
            path: target,
            type: stat.isDirectory()
                ? 'dir'
                : stat.isFile()
                    ? 'file'
                    : stat.isSymbolicLink()
                        ? 'link'
                        : 'other',
            size: stat.size,
            mode: stat.mode,
            mtime_ms: stat.mtimeMs,
        };
    }
    async fsMkdir(args) {
        const target = expandHomePath(this.validation.ensureString(args.path, 'path', { trim: false }));
        const recursive = args.recursive !== false;
        await fs.mkdir(target, { recursive, mode: 0o700 });
        this.stats.fs_ops += 1;
        return { success: true, path: target, recursive };
    }
    async fsRm(args) {
        const target = expandHomePath(this.validation.ensureString(args.path, 'path', { trim: false }));
        const recursive = args.recursive === true;
        const force = args.force === true;
        await fs.rm(target, { recursive, force });
        this.stats.fs_ops += 1;
        return { success: true, path: target, recursive, force };
    }
    getStats() {
        return { ...this.stats };
    }
    async cleanup() {
        return;
    }
}
module.exports = LocalManager;
