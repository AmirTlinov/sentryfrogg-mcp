#!/usr/bin/env node
"use strict";
// @ts-nocheck
Object.defineProperty(exports, "__esModule", { value: true });
function isTruthy(value) {
    if (value === undefined || value === null) {
        return false;
    }
    const normalized = String(value).trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}
function isUnsafeLocalEnabled() {
    return isTruthy(process.env.SENTRYFROGG_UNSAFE_LOCAL) || isTruthy(process.env.SF_UNSAFE_LOCAL);
}
module.exports = {
    isUnsafeLocalEnabled,
    isTruthy,
};
