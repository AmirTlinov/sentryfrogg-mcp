#!/usr/bin/env node
"use strict";
// @ts-nocheck
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * ✨ Suggestions / did-you-mean helpers (tiny, dependency-free).
 *
 * Design goals:
 * - Stable + deterministic (no randomness).
 * - Works well for snake_case / kebab-case / camelCase mismatches.
 * - Safe to use in errors: bounded output.
 */
function normalizeToken(value) {
    return String(value ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '');
}
function levenshtein(a, b) {
    const s = String(a ?? '');
    const t = String(b ?? '');
    if (s === t) {
        return 0;
    }
    const n = s.length;
    const m = t.length;
    if (n === 0) {
        return m;
    }
    if (m === 0) {
        return n;
    }
    const prev = new Array(m + 1);
    const curr = new Array(m + 1);
    for (let j = 0; j <= m; j += 1) {
        prev[j] = j;
    }
    for (let i = 1; i <= n; i += 1) {
        curr[0] = i;
        const si = s.charCodeAt(i - 1);
        for (let j = 1; j <= m; j += 1) {
            const cost = si === t.charCodeAt(j - 1) ? 0 : 1;
            curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
        }
        for (let j = 0; j <= m; j += 1) {
            prev[j] = curr[j];
        }
    }
    return prev[m];
}
function scoreCandidate(input, candidate) {
    const a = normalizeToken(input);
    const b = normalizeToken(candidate);
    if (!a || !b) {
        return Number.POSITIVE_INFINITY;
    }
    if (a === b) {
        return 0;
    }
    if (a.includes(b) || b.includes(a)) {
        return 1;
    }
    return levenshtein(a, b);
}
function maxAllowedDistance(input) {
    const normalized = normalizeToken(input);
    if (!normalized) {
        return 0;
    }
    if (normalized.length <= 4) {
        return 1;
    }
    if (normalized.length <= 8) {
        return 2;
    }
    return Math.max(3, Math.floor(normalized.length * 0.35));
}
function suggest(input, candidates, options = {}) {
    const limit = Number.isFinite(options.limit) ? Math.max(1, Math.floor(options.limit)) : 3;
    const rawCandidates = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
    if (!input || rawCandidates.length === 0) {
        return [];
    }
    const cap = Math.min(rawCandidates.length, 2000);
    const allowed = maxAllowedDistance(input);
    const scored = [];
    for (let idx = 0; idx < cap; idx += 1) {
        const cand = String(rawCandidates[idx]);
        const score = scoreCandidate(input, cand);
        if (!Number.isFinite(score)) {
            continue;
        }
        if (score <= allowed) {
            scored.push({ cand, score });
        }
    }
    scored.sort((a, b) => a.score - b.score || a.cand.length - b.cand.length || a.cand.localeCompare(b.cand));
    const out = [];
    for (const entry of scored) {
        if (out.includes(entry.cand)) {
            continue;
        }
        out.push(entry.cand);
        if (out.length >= limit) {
            break;
        }
    }
    return out;
}
module.exports = {
    suggest,
};
