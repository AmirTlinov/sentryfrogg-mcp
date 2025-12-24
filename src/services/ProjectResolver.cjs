#!/usr/bin/env node

/**
 * 🧭 ProjectResolver: resolves {project,target} context for tool calls.
 *
 * Contract:
 * - Never stores secrets (only names/refs).
 * - Uses active project from StateService when available.
 * - Resolves target via explicit args.target / args.project_target / args.environment,
 *   otherwise uses project.default_target or single-target auto-pick.
 */

const ACTIVE_PROJECT_KEY = 'project.active';

class ProjectResolver {
  constructor(validation, projectService, stateService) {
    this.validation = validation;
    this.projectService = projectService;
    this.stateService = stateService;
  }

  async resolveProjectName(args = {}) {
    const direct = args.project || args.project_name;
    if (direct) {
      return this.validation.ensureString(String(direct), 'project');
    }

    if (!this.stateService) {
      return undefined;
    }

    const active = await this.stateService.get(ACTIVE_PROJECT_KEY, 'any').catch(() => null);
    if (active && active.value) {
      return this.validation.ensureString(String(active.value), 'project');
    }

    return undefined;
  }

  resolveTarget(project, args = {}) {
    const targets = project.targets && typeof project.targets === 'object' ? project.targets : {};
    const requested = args.target || args.project_target || args.environment;

    if (requested) {
      const name = this.validation.ensureString(String(requested), 'target');
      const entry = targets[name];
      if (!entry) {
        throw new Error(`Unknown project target: ${name}`);
      }
      return { name, entry };
    }

    if (project.default_target) {
      const name = String(project.default_target);
      const entry = targets[name];
      if (entry) {
        return { name, entry };
      }
    }

    const names = Object.keys(targets);
    if (names.length === 1) {
      return { name: names[0], entry: targets[names[0]] };
    }

    if (names.length === 0) {
      throw new Error('Project has no targets configured');
    }

    throw new Error('target is required when project has multiple targets');
  }

  async resolveContext(args = {}) {
    const projectName = await this.resolveProjectName(args);
    if (!projectName) {
      return null;
    }

    if (!this.projectService) {
      throw new Error('Project resolution is unavailable (projectService not configured)');
    }

    const project = await this.projectService.getProject(projectName);
    const target = this.resolveTarget(project.project, args);

    return {
      projectName,
      project: project.project,
      targetName: target.name,
      target: target.entry,
    };
  }
}

module.exports = ProjectResolver;

