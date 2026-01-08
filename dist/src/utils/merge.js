#!/usr/bin/env node
"use strict";
// @ts-nocheck
Object.defineProperty(exports, "__esModule", { value: true });
function isPlainObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value);
}
function mergeDeep(base, override) {
    if (!isPlainObject(base) || !isPlainObject(override)) {
        return override !== undefined ? override : base;
    }
    const result = { ...base };
    for (const [key, value] of Object.entries(override)) {
        if (value === undefined) {
            continue;
        }
        if (isPlainObject(value) && isPlainObject(result[key])) {
            result[key] = mergeDeep(result[key], value);
        }
        else {
            result[key] = value;
        }
    }
    return result;
}
module.exports = {
    mergeDeep,
    isPlainObject,
};
