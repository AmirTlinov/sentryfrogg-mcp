#!/usr/bin/env node
"use strict";
// @ts-nocheck
Object.defineProperty(exports, "__esModule", { value: true });
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { once } = require('node:events');
const { atomicReplaceFile, atomicWriteTextFile, ensureDirForFile, tempSiblingPath, } = require('./fsAtomic');
const DEFAULT_CONTEXT_REPO_ROOT = '/home/amir/Документы/projects/context';
const DEFAULT_FILE_MODE = 0o600;
function isDirectory(candidate) {
    if (!candidate) {
        return false;
    }
    try {
        return fs.existsSync(candidate) && fs.statSync(candidate).isDirectory();
    }
    catch (error) {
        return false;
    }
}
function resolveContextRepoRoot() {
    const explicit = process.env.SENTRYFROGG_CONTEXT_REPO_ROOT || process.env.SF_CONTEXT_REPO_ROOT;
    if (explicit) {
        return isDirectory(explicit) ? explicit : null;
    }
    return isDirectory(DEFAULT_CONTEXT_REPO_ROOT) ? DEFAULT_CONTEXT_REPO_ROOT : null;
}
function normalizeSegment(value, label) {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`${label} must be a non-empty string`);
    }
    const trimmed = value.trim();
    if (trimmed === '.' || trimmed === '..') {
        throw new Error(`${label} must not be '.' or '..'`);
    }
    if (trimmed.includes('/') || trimmed.includes('\\')) {
        throw new Error(`${label} must not contain path separators`);
    }
    return trimmed;
}
function normalizeFilename(value) {
    const trimmed = normalizeSegment(value, 'filename');
    if (path.basename(trimmed) !== trimmed) {
        throw new Error('filename must be a basename only');
    }
    return trimmed;
}
function buildToolCallContextRef({ traceId, spanId }) {
    const runId = normalizeSegment(traceId || 'run', 'trace_id');
    const callId = normalizeSegment(spanId || crypto.randomUUID(), 'span_id');
    const rel = `runs/${runId}/tool_calls/${callId}.context`;
    return {
        uri: `artifact://${rel}`,
        rel,
    };
}
function buildToolCallFileRef({ traceId, spanId, filename }) {
    const runId = normalizeSegment(traceId || 'run', 'trace_id');
    const callId = normalizeSegment(spanId || crypto.randomUUID(), 'span_id');
    const safeName = normalizeFilename(filename);
    const rel = `runs/${runId}/tool_calls/${callId}/${safeName}`;
    return {
        uri: `artifact://${rel}`,
        rel,
    };
}
function resolveArtifactPath(contextRoot, rel) {
    if (!contextRoot) {
        throw new Error('contextRoot is required');
    }
    if (typeof rel !== 'string' || rel.trim().length === 0) {
        throw new Error('artifact rel must be a non-empty string');
    }
    const base = path.resolve(contextRoot, 'artifacts');
    const resolved = path.resolve(base, rel);
    if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) {
        throw new Error('Artifact path escapes context root');
    }
    return resolved;
}
async function writeTextArtifact(contextRoot, ref, content, options = {}) {
    if (!ref || typeof ref !== 'object') {
        throw new Error('artifact ref is required');
    }
    const mode = options.mode ?? DEFAULT_FILE_MODE;
    const filePath = resolveArtifactPath(contextRoot, ref.rel);
    const payload = typeof content === 'string' ? content : String(content ?? '');
    await atomicWriteTextFile(filePath, payload, { mode });
    return {
        uri: ref.uri,
        rel: ref.rel,
        path: filePath,
        bytes: Buffer.byteLength(payload, 'utf8'),
    };
}
async function writeBinaryArtifact(contextRoot, ref, buffer, options = {}) {
    if (!ref || typeof ref !== 'object') {
        throw new Error('artifact ref is required');
    }
    const mode = options.mode ?? DEFAULT_FILE_MODE;
    const filePath = resolveArtifactPath(contextRoot, ref.rel);
    const payload = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? '');
    const tmpPath = tempSiblingPath(filePath);
    await ensureDirForFile(filePath);
    try {
        await fsp.writeFile(tmpPath, payload, { mode });
        await atomicReplaceFile(tmpPath, filePath, { overwrite: true, mode });
    }
    catch (error) {
        await fsp.unlink(tmpPath).catch(() => null);
        throw error;
    }
    return {
        uri: ref.uri,
        rel: ref.rel,
        path: filePath,
        bytes: payload.length,
    };
}
async function createArtifactWriteStream(contextRoot, ref, options = {}) {
    if (!ref || typeof ref !== 'object') {
        throw new Error('artifact ref is required');
    }
    const mode = options.mode ?? DEFAULT_FILE_MODE;
    const filePath = resolveArtifactPath(contextRoot, ref.rel);
    const tmpPath = tempSiblingPath(filePath);
    await ensureDirForFile(filePath);
    const stream = fs.createWriteStream(tmpPath, { mode });
    const closePromise = once(stream, 'close').catch(() => null);
    let streamError = null;
    stream.on('error', (error) => {
        streamError = error;
    });
    let finished = false;
    let aborted = false;
    const finalize = async () => {
        if (aborted) {
            throw new Error('artifact stream was aborted');
        }
        if (!finished) {
            finished = true;
            if (!stream.destroyed && !stream.writableEnded) {
                stream.end();
            }
        }
        await closePromise;
        if (streamError) {
            await fsp.unlink(tmpPath).catch(() => null);
            throw streamError;
        }
        try {
            await atomicReplaceFile(tmpPath, filePath, { overwrite: true, mode });
            const stat = await fsp.stat(filePath);
            return {
                uri: ref.uri,
                rel: ref.rel,
                path: filePath,
                bytes: stat.size,
            };
        }
        catch (error) {
            await fsp.unlink(tmpPath).catch(() => null);
            throw error;
        }
    };
    const abort = async () => {
        if (aborted) {
            return;
        }
        aborted = true;
        stream.destroy();
        await closePromise;
        await fsp.unlink(tmpPath).catch(() => null);
    };
    return {
        uri: ref.uri,
        rel: ref.rel,
        path: filePath,
        tmp_path: tmpPath,
        stream,
        finalize,
        abort,
    };
}
async function copyFileArtifact(contextRoot, ref, sourcePath, options = {}) {
    if (!ref || typeof ref !== 'object') {
        throw new Error('artifact ref is required');
    }
    if (typeof sourcePath !== 'string' || sourcePath.trim().length === 0) {
        throw new Error('sourcePath must be a non-empty string');
    }
    const mode = options.mode ?? DEFAULT_FILE_MODE;
    const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : null;
    const filePath = resolveArtifactPath(contextRoot, ref.rel);
    const tmpPath = tempSiblingPath(filePath);
    await ensureDirForFile(filePath);
    try {
        if (!maxBytes) {
            await fsp.copyFile(sourcePath, tmpPath);
            await atomicReplaceFile(tmpPath, filePath, { overwrite: true, mode });
            const stat = await fsp.stat(filePath);
            return {
                uri: ref.uri,
                rel: ref.rel,
                path: filePath,
                bytes: stat.size,
                truncated: false,
            };
        }
        await new Promise((resolve, reject) => {
            const readStream = fs.createReadStream(sourcePath, { highWaterMark: 64 * 1024 });
            const writeStream = fs.createWriteStream(tmpPath, { mode });
            let written = 0;
            let done = false;
            const cleanup = () => {
                readStream.destroy();
                writeStream.end();
            };
            readStream.on('data', (chunk) => {
                if (done) {
                    return;
                }
                const remaining = maxBytes - written;
                if (remaining <= 0) {
                    done = true;
                    cleanup();
                    return;
                }
                if (chunk.length <= remaining) {
                    written += chunk.length;
                    writeStream.write(chunk);
                    return;
                }
                written += remaining;
                writeStream.write(chunk.subarray(0, remaining));
                done = true;
                cleanup();
            });
            readStream.on('error', (error) => {
                reject(error);
            });
            writeStream.on('error', (error) => {
                reject(error);
            });
            Promise.all([once(writeStream, 'close'), once(readStream, 'close')])
                .then(() => resolve())
                .catch(reject);
        });
        await atomicReplaceFile(tmpPath, filePath, { overwrite: true, mode });
        const stat = await fsp.stat(filePath);
        return {
            uri: ref.uri,
            rel: ref.rel,
            path: filePath,
            bytes: stat.size,
            truncated: true,
        };
    }
    catch (error) {
        await fsp.unlink(tmpPath).catch(() => null);
        throw error;
    }
}
module.exports = {
    resolveContextRepoRoot,
    buildToolCallContextRef,
    buildToolCallFileRef,
    resolveArtifactPath,
    writeTextArtifact,
    writeBinaryArtifact,
    createArtifactWriteStream,
    copyFileArtifact,
};
