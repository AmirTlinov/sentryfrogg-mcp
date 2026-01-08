#!/usr/bin/env node
"use strict";
// @ts-nocheck
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * 🔍 Generic matcher for "when" clauses (tags/files).
 */
const path = require('path');
const { pathExists } = require('./fsAtomic');
async function fileExists(root, candidate, cache) {
    if (!root || !candidate) {
        return false;
    }
    if (cache && Object.prototype.hasOwnProperty.call(cache, candidate)) {
        return cache[candidate];
    }
    const full = path.isAbsolute(candidate) ? candidate : path.join(root, candidate);
    const exists = await pathExists(full).catch(() => false);
    if (cache) {
        cache[candidate] = exists;
    }
    return exists;
}
function matchTags(tags = [], contextTags = []) {
    const tagSet = new Set(contextTags || []);
    return (tags || []).filter((tag) => tagSet.has(tag));
}
async function matchesWhen(when, context = {}) {
    if (!when) {
        return true;
    }
    if (typeof when !== 'object' || Array.isArray(when)) {
        return false;
    }
    const tags = new Set(context.tags || []);
    const filesCache = { ...(context.files || {}) };
    const root = context.root;
    const matchList = (list, predicate) => Array.isArray(list) ? predicate(list) : true;
    const all = async (list) => {
        for (const entry of list) {
            if (!await matchesWhen(entry, context)) {
                return false;
            }
        }
        return true;
    };
    const any = async (list) => {
        for (const entry of list) {
            if (await matchesWhen(entry, context)) {
                return true;
            }
        }
        return false;
    };
    if (Array.isArray(when.all_of) && !(await all(when.all_of))) {
        return false;
    }
    if (Array.isArray(when.any_of) && !(await any(when.any_of))) {
        return false;
    }
    if (when.not && await matchesWhen(when.not, context)) {
        return false;
    }
    const tagsAny = matchList(when.tags_any, (list) => list.some((tag) => tags.has(tag)));
    if (!tagsAny) {
        return false;
    }
    const tagsAll = matchList(when.tags_all, (list) => list.every((tag) => tags.has(tag)));
    if (!tagsAll) {
        return false;
    }
    if (Array.isArray(when.files_any) && when.files_any.length > 0) {
        let hit = false;
        for (const entry of when.files_any) {
            if (await fileExists(root, entry, filesCache)) {
                hit = true;
                break;
            }
        }
        if (!hit) {
            return false;
        }
    }
    if (Array.isArray(when.files_all) && when.files_all.length > 0) {
        for (const entry of when.files_all) {
            if (!await fileExists(root, entry, filesCache)) {
                return false;
            }
        }
    }
    return true;
}
module.exports = {
    fileExists,
    matchTags,
    matchesWhen,
};
