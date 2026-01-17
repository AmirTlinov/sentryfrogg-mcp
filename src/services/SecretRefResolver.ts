#!/usr/bin/env node
// @ts-nocheck

/**
 * 🔐 SecretRef resolver (ref:vault:kv2 / ref:env).
 *
 * Goal: a single, safe place to resolve secrets at runtime without mutating input configs.
 */

const ToolError = require('../errors/ToolError');

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
      throw ToolError.internal({
        code: 'VAULT_PROFILE_UNAVAILABLE',
        message: 'vault profile is required (profileService missing)',
        hint: 'This is a server configuration error. Enable ProfileService / VaultClient in bootstrap.',
      });
    }

    const profiles = await this.profileService.listProfiles('vault');
    if (profiles.length === 1) {
      return profiles[0].name;
    }
    if (profiles.length === 0) {
      throw ToolError.invalidParams({
        field: 'vault_profile_name',
        message: 'vault profile is required (no vault profiles exist)',
        hint: 'Create a vault profile first, or pass args.vault_profile_name explicitly.',
      });
    }
    throw ToolError.invalidParams({
      field: 'vault_profile_name',
      message: 'vault profile is required when multiple vault profiles exist',
      hint: 'Pass args.vault_profile_name explicitly (or configure target.vault_profile in project).',
      details: { known_profiles: profiles.map((p) => p.name) },
    });
  }

  async resolveRefString(value, args = {}, cache) {
    if (cache?.has(value)) {
      return cache.get(value);
    }

    const spec = value.slice(4);
    if (spec.startsWith('vault:kv2:')) {
      if (!this.vaultClient) {
        throw ToolError.internal({
          code: 'VAULT_CLIENT_UNAVAILABLE',
          message: 'vault refs require VaultClient (server misconfiguration)',
          hint: 'Enable VaultClient in server bootstrap.',
        });
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
        throw ToolError.invalidParams({
          field: 'ref',
          message: 'ref:env requires a non-empty env var name',
          hint: 'Example: \"ref:env:MY_TOKEN\".',
        });
      }
      const fromEnv = process.env[envKey];
      if (fromEnv === undefined) {
        throw ToolError.notFound({
          code: 'ENV_VAR_NOT_SET',
          message: `ref:env var is not set: ${envKey}`,
          hint: 'Set the env var in the server environment, or use ref:vault:kv2:<mount>/<path>#<key>.',
          details: { env: envKey },
        });
      }
      const resolved = String(fromEnv);
      cache?.set(value, resolved);
      return resolved;
    }

    const scheme = spec.split(':')[0] || 'unknown';
    throw ToolError.invalidParams({
      field: 'ref',
      message: `Unknown secret ref scheme: ${scheme}`,
      hint: 'Supported schemes: ref:vault:kv2:<mount>/<path>#<key>, ref:env:<ENV_VAR>.',
      details: { scheme },
    });
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
