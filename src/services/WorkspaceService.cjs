#!/usr/bin/env node

/**
 * 🧭 Workspace service: unified summary, suggestions, diagnostics.
 */

const fs = require('fs/promises');
const path = require('path');
const { buildStorePaths } = require('../utils/storeLayout.cjs');
const { resolveStoreInfo } = require('../utils/paths.cjs');
const { ensureDirForFile, pathExists } = require('../utils/fsAtomic.cjs');
const { matchesWhen, matchTags } = require('../utils/whenMatcher.cjs');

async function findGitRoot(startDir) {
  if (!startDir) {
    return undefined;
  }
  let current = startDir;
  for (let depth = 0; depth < 25; depth += 1) {
    const candidate = path.join(current, '.git');
    try {
      if (await pathExists(candidate)) {
        return current;
      }
    } catch (error) {
      return undefined;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return undefined;
}

class WorkspaceService {
  constructor(logger, contextService, projectResolver, profileService, runbookService, capabilityService, projectService, aliasService, presetService, stateService) {
    this.logger = logger.child('workspace');
    this.contextService = contextService;
    this.projectResolver = projectResolver;
    this.profileService = profileService;
    this.runbookService = runbookService;
    this.capabilityService = capabilityService;
    this.projectService = projectService;
    this.aliasService = aliasService;
    this.presetService = presetService;
    this.stateService = stateService;
  }

  async getStoreStatus() {
    const info = resolveStoreInfo();
    const baseItems = buildStorePaths(info.base_dir);
    const legacyItems = info.legacy_dir ? buildStorePaths(info.legacy_dir) : [];

    const collect = async (items) => {
      const results = {};
      for (const item of items) {
        const exists = await pathExists(item.path).catch(() => false);
        results[item.key] = {
          exists,
          path: item.path,
          kind: item.kind,
          sensitive: item.sensitive,
        };
      }
      return results;
    };

    return {
      ...info,
      files: await collect(baseItems),
      legacy_files: legacyItems.length ? await collect(legacyItems) : undefined,
    };
  }

  async resolveProjectContext(args = {}) {
    if (!this.projectResolver) {
      return null;
    }
    try {
      return await this.projectResolver.resolveContext(args);
    } catch (error) {
      return { error: error.message };
    }
  }

  async getInventory() {
    const profiles = await this.profileService.listProfiles();
    const profileCounts = {};
    for (const profile of profiles) {
      profileCounts[profile.type] = (profileCounts[profile.type] || 0) + 1;
    }

    const runbookList = await this.runbookService.listRunbooks();
    const runbookCounts = { total: runbookList.runbooks.length };
    const runbookTags = {};
    const runbookSources = {};
    for (const runbook of runbookList.runbooks) {
      runbookSources[runbook.source || 'local'] = (runbookSources[runbook.source || 'local'] || 0) + 1;
      for (const tag of runbook.tags || []) {
        runbookTags[tag] = (runbookTags[tag] || 0) + 1;
      }
    }

    const capabilities = await this.capabilityService.listCapabilities();
    const capabilitySources = {};
    for (const capability of capabilities) {
      capabilitySources[capability.source || 'local'] = (capabilitySources[capability.source || 'local'] || 0) + 1;
    }

    const projects = await this.projectService.listProjects();
    const aliasStats = this.aliasService.getStats();
    const presetStats = this.presetService.getStats();
    const stateStats = this.stateService.getStats();

    return {
      profiles: {
        total: profiles.length,
        by_type: profileCounts,
      },
      runbooks: {
        total: runbookList.runbooks.length,
        by_source: runbookSources,
        by_tag: runbookTags,
      },
      capabilities: {
        total: capabilities.length,
        by_source: capabilitySources,
      },
      projects: { total: projects.projects.length },
      aliases: { total: aliasStats.total },
      presets: { total: presetStats.total },
      state: {
        session_keys: stateStats.session_keys,
        persistent_keys: stateStats.persistent_keys,
      },
    };
  }

  async suggestCapabilities(context, limit) {
    const capabilities = await this.capabilityService.listCapabilities();
    const suggestions = [];
    for (const capability of capabilities) {
      if (await matchesWhen(capability.when, context)) {
        suggestions.push({
          name: capability.name,
          intent: capability.intent,
          description: capability.description,
          tags: capability.tags || [],
          effects: capability.effects,
          source: capability.source || 'local',
        });
      }
    }
    suggestions.sort((a, b) => a.name.localeCompare(b.name));
    if (typeof limit === 'number') {
      return suggestions.slice(0, limit);
    }
    return suggestions;
  }

  async suggestRunbooks(context, limit, includeUntagged = false) {
    const runbookList = await this.runbookService.listRunbooks();
    const suggestions = [];
    for (const runbook of runbookList.runbooks) {
      let matched = false;
      let matchedTags = [];

      if (runbook.when && await matchesWhen(runbook.when, context)) {
        matched = true;
      } else if (runbook.tags && runbook.tags.length > 0) {
        matchedTags = matchTags(runbook.tags, context.tags || []);
        matched = matchedTags.length > 0;
      } else if (includeUntagged) {
        matched = true;
      }

      if (matched) {
        suggestions.push({
          name: runbook.name,
          description: runbook.description,
          tags: runbook.tags || [],
          inputs: runbook.inputs,
          source: runbook.source || 'local',
          reason: matchedTags.length ? { tags: matchedTags } : undefined,
        });
      }
    }

    suggestions.sort((a, b) => a.name.localeCompare(b.name));
    if (typeof limit === 'number') {
      return suggestions.slice(0, limit);
    }
    return suggestions;
  }

  async summarize(args = {}) {
    const contextResult = await this.contextService.getContext(args);
    const context = contextResult.context || {};
    const projectContext = await this.resolveProjectContext(args);
    const store = await this.getStoreStatus();
    const inventory = await this.getInventory();

    const suggestions = {
      capabilities: await this.suggestCapabilities(context, args.limit),
      runbooks: await this.suggestRunbooks(context, args.limit, args.include_untagged === true),
    };

    return {
      success: true,
      workspace: {
        context: {
          key: context.key,
          root: context.root,
          tags: context.tags,
          project_name: context.project_name,
          target_name: context.target_name,
          updated_at: context.updated_at,
        },
        project: projectContext && !projectContext.error ? {
          name: projectContext.projectName,
          target: projectContext.targetName,
          description: projectContext.project?.description,
          repo_root: projectContext.project?.repo_root,
          target_info: projectContext.target || {},
        } : undefined,
        project_error: projectContext?.error,
        store,
        inventory,
        suggestions,
      },
    };
  }

  async suggest(args = {}) {
    const contextResult = await this.contextService.getContext(args);
    const context = contextResult.context || {};
    const suggestions = {
      capabilities: await this.suggestCapabilities(context, args.limit),
      runbooks: await this.suggestRunbooks(context, args.limit, args.include_untagged === true),
    };
    return {
      success: true,
      context: {
        key: context.key,
        root: context.root,
        tags: context.tags,
      },
      suggestions,
    };
  }

  async diagnose(args = {}) {
    const store = await this.getStoreStatus();
    const contextResult = await this.contextService.getContext(args);
    const context = contextResult.context || {};
    const projectContext = await this.resolveProjectContext(args);
    const inventory = await this.getInventory();

    const warnings = [];
    const hints = [];

    const legacyHasSensitive = store.legacy_files
      ? Object.values(store.legacy_files).some((entry) => entry.sensitive && entry.exists)
      : false;

    if (store.legacy_dir && store.legacy_dir !== store.base_dir && legacyHasSensitive) {
      warnings.push({
        code: 'legacy_store_detected',
        message: `Обнаружено legacy-хранилище: ${store.legacy_dir}`,
        action: { tool: 'mcp_workspace', args: { action: 'migrate_legacy', apply: true } },
      });
    }

    const gitRoot = await findGitRoot(store.base_dir);
    if (gitRoot && store.mode !== 'custom') {
      warnings.push({
        code: 'store_inside_repo',
        message: `Хранилище расположено внутри git-репозитория: ${store.base_dir}`,
        action: { tool: 'mcp_workspace', args: { action: 'store_status' } },
      });
    }

    if (projectContext?.target && !projectContext.error) {
      const target = projectContext.target || {};
      const missing = [];
      for (const [label, value] of Object.entries({
        ssh_profile: target.ssh_profile,
        env_profile: target.env_profile,
        postgres_profile: target.postgres_profile,
        api_profile: target.api_profile,
        vault_profile: target.vault_profile,
      })) {
        if (value && !this.profileService.hasProfile(String(value))) {
          missing.push(label);
        }
      }
      if (missing.length > 0) {
        warnings.push({
          code: 'missing_profiles',
          message: `Не найдены профили для target: ${missing.join(', ')}`,
        });
      }
    }

    if (inventory.runbooks.total === 0) {
      hints.push({ code: 'no_runbooks', message: 'Нет доступных runbook-ов. Добавьте через mcp_runbook.' });
    }

    if (inventory.capabilities.total === 0) {
      hints.push({ code: 'no_capabilities', message: 'Нет доступных capability. Проверьте capabilities.json.' });
    }

    return {
      success: true,
      diagnostics: {
        warnings,
        hints,
      },
      context: {
        key: context.key,
        root: context.root,
        tags: context.tags,
      },
      store,
      inventory,
      project: projectContext && !projectContext.error ? {
        name: projectContext.projectName,
        target: projectContext.targetName,
      } : undefined,
      project_error: projectContext?.error,
    };
  }

  async getStats() {
    const store = await this.getStoreStatus();
    const inventory = await this.getInventory();
    return { success: true, store, inventory };
  }

  async migrateLegacy(args = {}) {
    const store = await this.getStoreStatus();
    const legacyDir = store.legacy_dir;
    const baseDir = store.base_dir;

    if (!legacyDir || legacyDir === baseDir) {
      return { success: false, message: 'Legacy store not found or already active.' };
    }

    const includeDirs = args.include_dirs === true;
    const apply = args.apply === true;
    const cleanup = args.cleanup === true;
    const overwrite = args.overwrite === true;

    const items = buildStorePaths(legacyDir);
    const plan = {
      from: legacyDir,
      to: baseDir,
      copied: [],
      skipped: [],
      cleaned: [],
    };

    for (const item of items) {
      const sourcePath = item.path;
      const targetPath = path.join(baseDir, item.relative);
      const exists = await pathExists(sourcePath).catch(() => false);
      if (!exists) {
        continue;
      }

      if (item.kind === 'dir' && !includeDirs) {
        plan.skipped.push({ item: item.key, reason: 'dir_skipped', path: sourcePath });
        continue;
      }

      const targetExists = await pathExists(targetPath).catch(() => false);
      if (targetExists && !overwrite) {
        plan.skipped.push({ item: item.key, reason: 'exists', path: targetPath });
        continue;
      }

      if (apply) {
        if (item.kind === 'dir') {
          await fs.cp(sourcePath, targetPath, { recursive: true, force: overwrite });
        } else {
          await ensureDirForFile(targetPath);
          await fs.copyFile(sourcePath, targetPath);
        }
        plan.copied.push({ item: item.key, path: targetPath });
        if (cleanup) {
          if (item.kind === 'dir') {
            await fs.rm(sourcePath, { recursive: true, force: true });
          } else {
            await fs.unlink(sourcePath).catch(() => null);
          }
          plan.cleaned.push({ item: item.key, path: sourcePath });
        }
      } else {
        plan.copied.push({ item: item.key, path: targetPath, dry_run: true });
      }
    }

    return {
      success: true,
      applied: apply,
      cleanup,
      plan,
    };
  }
}

module.exports = WorkspaceService;
