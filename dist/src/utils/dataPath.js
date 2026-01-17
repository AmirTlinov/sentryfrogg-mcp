#!/usr/bin/env node
"use strict";
// @ts-nocheck
Object.defineProperty(exports, "__esModule", { value: true });
const ToolError = require('../errors/ToolError');
function parsePath(path) {
    if (typeof path !== 'string' || path.trim().length === 0) {
        throw ToolError.invalidParams({ field: 'path', message: 'Path must be a non-empty string' });
    }
    const segments = [];
    const pattern = /([^[.\]]+)|\[(.*?)\]/g;
    let match;
    while ((match = pattern.exec(path)) !== null) {
        const raw = match[1] !== undefined ? match[1] : match[2];
        if (raw === undefined || raw === '') {
            continue;
        }
        const trimmed = raw.trim();
        if (!trimmed) {
            continue;
        }
        const unquoted = trimmed.replace(/^['"]|['"]$/g, '');
        if (/^\d+$/.test(unquoted)) {
            segments.push(Number.parseInt(unquoted, 10));
        }
        else {
            segments.push(unquoted);
        }
    }
    return segments;
}
function getPathValue(target, path, { defaultValue, required } = {}) {
    if (path === undefined || path === null || path === '') {
        return target;
    }
    const segments = Array.isArray(path) ? path : parsePath(path);
    let current = target;
    for (const segment of segments) {
        if (current === undefined || current === null) {
            if (required) {
                throw ToolError.invalidParams({
                    field: 'path',
                    message: `Path '${Array.isArray(path) ? path.join('.') : path}' not found`,
                });
            }
            return defaultValue;
        }
        current = current[segment];
    }
    if (current === undefined && required) {
        throw ToolError.invalidParams({
            field: 'path',
            message: `Path '${Array.isArray(path) ? path.join('.') : path}' not found`,
        });
    }
    return current === undefined ? defaultValue : current;
}
module.exports = {
    parsePath,
    getPathValue,
};
