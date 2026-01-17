#!/usr/bin/env node
"use strict";
// @ts-nocheck
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * 🗂️ Project manager.
 */
const { unknownActionError } = require('../utils/toolErrors');
const ACTIVE_PROJECT_KEY = 'project.active';
const PROJECT_ACTIONS = [
    'project_upsert',
    'project_get',
    'project_list',
    'project_delete',
    'project_use',
    'project_active',
    'project_unuse',
];
class ProjectManager {
    constructor(logger, validation, projectService, stateService) {
        this.logger = logger.child('project');
        this.validation = validation;
        this.projectService = projectService;
        this.stateService = stateService;
    }
    async handleAction(args = {}) {
        const { action } = args;
        switch (action) {
            case 'project_upsert':
                return this.projectUpsert(args.name, args);
            case 'project_get':
                return this.projectGet(args.name);
            case 'project_list':
                return this.projectList();
            case 'project_delete':
                return this.projectDelete(args.name);
            case 'project_use':
                return this.projectUse(args.name, args.scope);
            case 'project_active':
                return this.projectActive(args.scope);
            case 'project_unuse':
                return this.projectUnuse(args.scope);
            default:
                throw unknownActionError({ tool: 'project', action, knownActions: PROJECT_ACTIONS });
        }
    }
    buildProjectPayload(args) {
        const payload = args.project && typeof args.project === 'object' ? args.project : {
            description: args.description,
            default_target: args.default_target,
            targets: args.targets,
        };
        return payload;
    }
    async projectUpsert(name, args) {
        const projectName = this.validation.ensureString(name, 'Project name');
        const payload = this.buildProjectPayload(args);
        return this.projectService.setProject(projectName, payload);
    }
    async projectGet(name) {
        const projectName = this.validation.ensureString(name, 'Project name');
        return this.projectService.getProject(projectName);
    }
    async projectList() {
        return this.projectService.listProjects();
    }
    async projectDelete(name) {
        const projectName = this.validation.ensureString(name, 'Project name');
        return this.projectService.deleteProject(projectName);
    }
    async projectUse(name, scope) {
        const projectName = this.validation.ensureString(name, 'Project name');
        await this.projectService.getProject(projectName);
        const targetScope = scope || 'persistent';
        await this.stateService.set(ACTIVE_PROJECT_KEY, projectName, targetScope);
        return { success: true, project: projectName, scope: targetScope };
    }
    async projectActive(scope) {
        const state = await this.stateService.get(ACTIVE_PROJECT_KEY, scope || 'any');
        return { success: true, project: state.value, scope: state.scope };
    }
    async projectUnuse(scope) {
        const cleared = await this.stateService.unset(ACTIVE_PROJECT_KEY, scope || 'any');
        return { success: true, ...cleared };
    }
    getStats() {
        return this.projectService.getStats();
    }
    async cleanup() {
        await this.projectService.cleanup();
    }
}
module.exports = ProjectManager;
