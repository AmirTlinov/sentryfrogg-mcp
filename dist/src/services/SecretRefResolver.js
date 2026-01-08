#!/usr/bin/env node
"use strict";
// @ts-nocheck
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * 🔐 SecretRef resolver (ref:vault:kv2 / ref:env).
 *
 * Goal: a single, safe place to resolve secrets at runtime without mutating input configs.
 */
class SecretRefResolver {
    constructor(logger, validation, profileService, vaultClient, projectResolver) {
        this.logger = logger.child('secrets');
        this.validation = validation;
        this.profileService = profileService;
        this.vaultClient = vaultClient;
        this.projectResolver = projectResolver;
    }
    async resolveVaultProfileName(args = {}) {
        if (args.vault_profile_name) {
            return this.validation.ensureString(String(args.vault_profile_name), 'vault_profile_name');
        }
        if (args.vault_profile) {
            return this.validation.ensureString(String(args.vault_profile), 'vault_profile');
        }
        if (this.projectResolver) {
            const context = await this.projectResolver.resolveContext(args).catch(() => null);
            const vaultProfile = context?.target?.vault_profile;
            if (vaultProfile) {
                return this.validation.ensureString(String(vaultProfile), 'vault_profile');
            }
        }
        if (!this.profileService) {
            throw new Error('vault profile is required (profileService missing)');
        }
        const profiles = await this.profileService.listProfiles('vault');
        if (profiles.length === 1) {
            return profiles[0].name;
        }
        if (profiles.length === 0) {
            throw new Error('vault profile is required (no vault profiles exist)');
        }
        throw new Error('vault profile is required when multiple vault profiles exist');
    }
    async resolveRefString(value, args = {}, cache) {
        if (cache?.has(value)) {
            return cache.get(value);
        }
        const spec = value.slice(4);
        if (spec.startsWith('vault:kv2:')) {
            if (!this.vaultClient) {
                throw new Error('vault refs require VaultClient (server misconfiguration)');
            }
            const ref = spec.slice('vault:kv2:'.length);
            const profileName = await this.resolveVaultProfileName(args);
            const resolved = await this.vaultClient.kv2Get(profileName, ref, { timeout_ms: args.timeout_ms });
            cache?.set(value, resolved);
            return resolved;
        }
        if (spec.startsWith('env:')) {
            const envKey = spec.slice('env:'.length).trim();
            if (!envKey) {
                throw new Error('ref:env requires a non-empty env var name');
            }
            const fromEnv = process.env[envKey];
            if (fromEnv === undefined) {
                throw new Error(`ref:env var is not set: ${envKey}`);
            }
            const resolved = String(fromEnv);
            cache?.set(value, resolved);
            return resolved;
        }
        const scheme = spec.split(':')[0] || 'unknown';
        throw new Error(`Unknown secret ref scheme: ${scheme}`);
    }
    async resolveDeep(input, args = {}) {
        const cache = new Map();
        const walk = async (value) => {
            if (value === null || value === undefined) {
                return value;
            }
            if (typeof value === 'string') {
                if (!value.startsWith('ref:')) {
                    return value;
                }
                return this.resolveRefString(value, args, cache);
            }
            if (typeof value !== 'object') {
                return value;
            }
            if (Buffer.isBuffer(value)) {
                return value;
            }
            if (Array.isArray(value)) {
                const out = [];
                for (const item of value) {
                    out.push(await walk(item));
                }
                return out;
            }
            const out = {};
            for (const [key, child] of Object.entries(value)) {
                out[key] = await walk(child);
            }
            return out;
        };
        return walk(input);
    }
}
module.exports = SecretRefResolver;
