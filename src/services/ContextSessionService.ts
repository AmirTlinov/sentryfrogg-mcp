#!/usr/bin/env node
// @ts-nocheck

/**
 * 🧭 ContextSession: resolved context + project/target bindings + diagnostics.
 *
 * Goal: single source of truth for workspace actions and preflight hints.
 */

const { pathExists } = require('../utils/fsAtomic');
const { expandHomePath } = require('../utils/userPaths');

const PROFILE_TYPES = {
  ssh_profile: 'ssh',
  env_profile: 'env',
  postgres_profile: 'postgresql',
  api_profile: 'api',
  vault_profile: 'vault',
};

function normalizeString(value) {
  if (value === undefined || value === null) {
    return undefined;
  }
  const trimmed = String(value).trim();
  return trimmed ? trimmed : undefined;
}

function readRefEnv(value) {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith('ref:env:')) {
    return undefined;
  }
  const key = trimmed.slice('ref:env:'.length).trim();
  return key || undefined;
}

function readRefVault(value) {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith('ref:vault:')) {
    return undefined;
  }
  return trimmed;
}

class ContextSessionService {
  constructor(logger, contextService, projectResolver, profileService) {
    this.logger = logger.child('context_session');
    this.contextService = contextService;
    this.projectResolver = projectResolver;
    this.profileService = profileService;
  }

  async resolve(args = {}) {
    const diagnostics = {
      errors: [],
      warnings: [],
      hints: [],
    };

    const contextResult = await this.contextService.getContext(args).catch((error) => {
      diagnostics.errors.push({
        code: 'context_failed',
        message: error.message,
      });
      return { context: {} };
    });
    const context = contextResult.context || {};

    let projectContext = null;
    if (this.projectResolver) {
      projectContext = await this.projectResolver.resolveContext(args).catch((error) => ({
        error: error.message,
      }));
    }

    if (projectContext?.error) {
      diagnostics.errors.push({
        code: 'project_resolution_failed',
        message: projectContext.error,
      });
    }

    const target = projectContext?.target || null;
    const bindings = {
      profiles: {},
      paths: {},
      urls: {},
    };

    if (target) {
      for (const key of Object.keys(PROFILE_TYPES)) {
        if (target[key]) {
          bindings.profiles[key] = normalizeString(target[key]);
        }
      }

      if (target.kubeconfig) {
        bindings.paths.kubeconfig = normalizeString(target.kubeconfig);
      }
      if (target.sops_age_key_file) {
        bindings.paths.sops_age_key_file = normalizeString(target.sops_age_key_file);
      }
      if (target.repo_path || target.repo_root) {
        bindings.paths.repo_root = normalizeString(target.repo_path || target.repo_root);
      }
      if (target.cwd) {
        bindings.paths.cwd = normalizeString(target.cwd);
      }
      if (target.api_base_url) {
        bindings.urls.api_base_url = normalizeString(target.api_base_url);
      }
      if (target.registry_url) {
        bindings.urls.registry_url = normalizeString(target.registry_url);
      }
    }

    const effectiveTags = new Set(context.tags || []);
    if (bindings.paths.kubeconfig) {
      effectiveTags.add('k8s');
    }
    if (bindings.profiles.ssh_profile) {
      effectiveTags.add('ssh');
    }
    if (bindings.urls.api_base_url) {
      effectiveTags.add('api');
    }
    if (bindings.urls.registry_url) {
      effectiveTags.add('registry');
    }

    const effectiveContext = {
      ...context,
      tags: Array.from(effectiveTags).sort(),
    };

    await this.checkBindings(bindings, diagnostics);

    return {
      context,
      effective_context: effectiveContext,
      project_context: projectContext && !projectContext.error ? projectContext : null,
      diagnostics,
      bindings,
    };
  }

  async checkBindings(bindings, diagnostics) {
    const pathChecks = [
      { key: 'kubeconfig', label: 'kubeconfig' },
      { key: 'sops_age_key_file', label: 'sops_age_key_file' },
      { key: 'repo_root', label: 'repo_root' },
    ];

    for (const entry of pathChecks) {
      const raw = bindings.paths[entry.key];
      if (!raw) {
        continue;
      }
      const refEnv = readRefEnv(raw);
      if (refEnv) {
        if (process.env[refEnv] === undefined) {
          diagnostics.warnings.push({
            code: 'env_ref_missing',
            message: `Переменная окружения не задана: ${refEnv}`,
            meta: { ref: raw },
          });
        }
        continue;
      }

      const refVault = readRefVault(raw);
      if (refVault) {
        diagnostics.hints.push({
          code: 'vault_ref_detected',
          message: 'Обнаружена vault-ссылка в путях. Убедитесь, что настроен vault_profile.',
          meta: { ref: refVault },
        });
        continue;
      }

      const expanded = expandHomePath(raw);
      const exists = await pathExists(expanded).catch(() => false);
      if (!exists) {
        diagnostics.warnings.push({
          code: 'path_missing',
          message: `Файл не найден: ${raw}`,
          meta: { key: entry.key },
        });
      }
    }

    if (this.profileService) {
      for (const [key, profileName] of Object.entries(bindings.profiles)) {
        if (!profileName) {
          continue;
        }
        if (!this.profileService.hasProfile(profileName)) {
          diagnostics.warnings.push({
            code: 'missing_profile',
            message: `Профиль не найден: ${profileName}`,
            meta: { key },
          });
          continue;
        }

        const expectedType = PROFILE_TYPES[key];
        if (expectedType && this.profileService.probeProfileSecrets) {
          const probe = await this.profileService.probeProfileSecrets(profileName, expectedType);
          if (!probe.ok) {
            diagnostics.warnings.push({
              code: 'profile_secrets_unreadable',
              message: `Секреты профиля недоступны: ${profileName}`,
              meta: { error: probe.error, key },
            });
          }
        }
      }
    }

    const apiRef = readRefEnv(bindings.urls.api_base_url);
    if (apiRef && process.env[apiRef] === undefined) {
      diagnostics.warnings.push({
        code: 'env_ref_missing',
        message: `Переменная окружения не задана: ${apiRef}`,
        meta: { ref: bindings.urls.api_base_url },
      });
    }
  }
}

module.exports = ContextSessionService;
