#!/usr/bin/env node
"use strict";
// @ts-nocheck
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * 🧱 Vault manager: profiles + basic diagnostics.
 */
const { isTruthy } = require('../utils/featureFlags');
const VAULT_PROFILE_TYPE = 'vault';
class VaultManager {
    constructor(logger, validation, profileService, vaultClient) {
        this.logger = logger.child('vault');
        this.validation = validation;
        this.profileService = profileService;
        this.vaultClient = vaultClient;
    }
    async handleAction(args = {}) {
        const { action } = args;
        switch (action) {
            case 'profile_upsert':
                return this.profileUpsert(args.profile_name, args);
            case 'profile_get':
                return this.profileGet(args.profile_name, args.include_secrets);
            case 'profile_list':
                return this.profileList();
            case 'profile_delete':
                return this.profileDelete(args.profile_name);
            case 'profile_test':
                return this.profileTest(args.profile_name, args);
            default:
                throw new Error(`Unknown vault action: ${action}`);
        }
    }
    async profileUpsert(profileName, params = {}) {
        const name = this.validation.ensureString(profileName, 'profile_name');
        const addr = this.validation.ensureString(params.addr, 'addr', { trim: true });
        const namespace = params.namespace === undefined
            ? undefined
            : (params.namespace === null || !String(params.namespace).trim() ? null : String(params.namespace).trim());
        const authType = params.auth_type !== undefined && params.auth_type !== null && String(params.auth_type).trim()
            ? String(params.auth_type).trim().toLowerCase()
            : undefined;
        const token = params.token === undefined ? undefined : (params.token === null ? null : String(params.token));
        const roleId = params.role_id === undefined ? undefined : (params.role_id === null ? null : String(params.role_id));
        const secretId = params.secret_id === undefined ? undefined : (params.secret_id === null ? null : String(params.secret_id));
        const tokenValue = typeof token === 'string' && token.trim() ? token : null;
        const roleIdValue = typeof roleId === 'string' && roleId.trim() ? roleId : null;
        const secretIdValue = typeof secretId === 'string' && secretId.trim() ? secretId : null;
        const inferredAuth = authType || (tokenValue ? 'token' : (roleIdValue || secretIdValue ? 'approle' : 'none'));
        if (!['token', 'approle', 'none'].includes(inferredAuth)) {
            throw new Error(`Unknown vault auth_type: ${String(inferredAuth)}`);
        }
        if (inferredAuth === 'token' && !tokenValue) {
            throw new Error('token is required for vault auth_type=token');
        }
        if (inferredAuth === 'approle') {
            if (!roleIdValue) {
                throw new Error('role_id is required for vault auth_type=approle');
            }
            if (!secretIdValue) {
                throw new Error('secret_id is required for vault auth_type=approle');
            }
        }
        let previous = null;
        try {
            previous = await this.profileService.getProfile(name, VAULT_PROFILE_TYPE);
        }
        catch (error) {
            if (!String(error?.message || '').includes('not found')) {
                throw error;
            }
        }
        await this.profileService.setProfile(name, {
            type: VAULT_PROFILE_TYPE,
            data: { addr, namespace, auth_type: inferredAuth === 'none' ? null : inferredAuth },
            secrets: {
                token,
                role_id: roleId,
                secret_id: secretId,
            },
        });
        try {
            await this.vaultClient.sysHealth(name, { timeout_ms: params.timeout_ms });
            if (tokenValue) {
                await this.vaultClient.tokenLookupSelf(name, { timeout_ms: params.timeout_ms });
            }
        }
        catch (error) {
            // Roll back on validation failure.
            if (previous) {
                await this.profileService.setProfile(name, {
                    type: VAULT_PROFILE_TYPE,
                    data: previous.data || {},
                    secrets: previous.secrets || {},
                }).catch(() => null);
            }
            else {
                await this.profileService.deleteProfile(name).catch(() => null);
            }
            throw error;
        }
        return {
            success: true,
            profile: {
                name,
                type: VAULT_PROFILE_TYPE,
                data: { addr, namespace, auth_type: inferredAuth === 'none' ? undefined : inferredAuth },
                auth: inferredAuth === 'approle' ? 'approle' : (tokenValue ? 'token' : 'none'),
            },
        };
    }
    async profileGet(profileName, includeSecrets = false) {
        const name = this.validation.ensureString(profileName, 'profile_name');
        const profile = await this.profileService.getProfile(name, VAULT_PROFILE_TYPE);
        const allow = isTruthy(process.env.SENTRYFROGG_ALLOW_SECRET_EXPORT) || isTruthy(process.env.SF_ALLOW_SECRET_EXPORT);
        if (includeSecrets && allow) {
            return { success: true, profile };
        }
        const secretKeys = profile.secrets ? Object.keys(profile.secrets).sort() : [];
        return {
            success: true,
            profile: {
                name: profile.name,
                type: profile.type,
                data: profile.data,
                secrets: secretKeys,
                secrets_redacted: true,
            },
        };
    }
    async profileList() {
        const profiles = await this.profileService.listProfiles(VAULT_PROFILE_TYPE);
        return { success: true, profiles };
    }
    async profileDelete(profileName) {
        const name = this.validation.ensureString(profileName, 'profile_name');
        await this.profileService.deleteProfile(name);
        return { success: true, profile: name };
    }
    async profileTest(profileName, params = {}) {
        const name = this.validation.ensureString(profileName, 'profile_name');
        const health = await this.vaultClient.sysHealth(name, { timeout_ms: params.timeout_ms });
        let token = null;
        try {
            token = await this.vaultClient.tokenLookupSelf(name, { timeout_ms: params.timeout_ms });
        }
        catch (error) {
            token = { success: false, error: error.message };
        }
        return { success: true, profile_name: name, health, token };
    }
}
module.exports = VaultManager;
