#!/usr/bin/env node

/**
 * 🚀 SERVICE BOOTSTRAP
 * Service Layer инициализация и Dependency Injection контейнер
 */

class ServiceContainer {
  constructor() {
    this.services = new Map();
    this.singletons = new Map();
  }

  // Регистрация сервиса
  register(name, factory, options = {}) {
    this.services.set(name, {
      factory,
      singleton: options.singleton || false,
      dependencies: options.dependencies || []
    });
  }

  // Получение сервиса
  get(name) {
    if (!this.services.has(name)) {
      throw new Error(`Service '${name}' not found`);
    }

    const service = this.services.get(name);
    
    // Если singleton и уже создан
    if (service.singleton && this.singletons.has(name)) {
      return this.singletons.get(name);
    }

    // Создание экземпляра
    const dependencies = service.dependencies.map(dep => this.get(dep));
    const instance = service.factory(...dependencies);

    // Сохранение singleton
    if (service.singleton) {
      this.singletons.set(name, instance);
    }

    return instance;
  }

  // Проверка существования сервиса
  has(name) {
    return this.services.has(name);
  }

  // Получение статистики
  getStats() {
    return {
      registered: this.services.size,
      singletons: this.singletons.size,
      services: Array.from(this.services.keys())
    };
  }
}

class ServiceBootstrap {
  static container = null;
  static initialized = false;

  static async initialize() {
    if (this.initialized) {
      return this.container;
    }

    try {
      this.container = new ServiceContainer();
      
      // Регистрация базовых сервисов
      await this.registerBaseServices();
      
      // Регистрация менеджеров
      await this.registerManagers();

      // Прогреваем профильный сервис, чтобы избежать гонок при первом запросе
      if (this.container.has('profileService')) {
        const profileService = this.container.get('profileService');
        await profileService.initialize();
      }
      if (this.container.has('stateService')) {
        const stateService = this.container.get('stateService');
        await stateService.initialize();
      }
      if (this.container.has('projectService')) {
        const projectService = this.container.get('projectService');
        await projectService.initialize();
      }
      if (this.container.has('runbookService')) {
        const runbookService = this.container.get('runbookService');
        await runbookService.initialize();
      }
      if (this.container.has('contextService')) {
        const contextService = this.container.get('contextService');
        await contextService.initialize();
      }
      if (this.container.has('capabilityService')) {
        const capabilityService = this.container.get('capabilityService');
        await capabilityService.initialize();
      }
      if (this.container.has('aliasService')) {
        const aliasService = this.container.get('aliasService');
        await aliasService.initialize();
      }
      if (this.container.has('presetService')) {
        const presetService = this.container.get('presetService');
        await presetService.initialize();
      }

      if (this.container.has('toolExecutor') && this.container.has('runbookManager')) {
        const toolExecutor = this.container.get('toolExecutor');
        const runbookManager = this.container.get('runbookManager');
        toolExecutor.register('mcp_runbook', (args) => runbookManager.handleAction(args));
      }

      if (this.container.has('toolExecutor') && this.container.has('intentManager')) {
        const toolExecutor = this.container.get('toolExecutor');
        const intentManager = this.container.get('intentManager');
        toolExecutor.register('mcp_intent', (args) => intentManager.handleAction(args));
        toolExecutor.aliasMap.intent = 'mcp_intent';
      }

      if (this.container.has('toolExecutor') && this.container.has('workspaceManager')) {
        const toolExecutor = this.container.get('toolExecutor');
        const workspaceManager = this.container.get('workspaceManager');
        toolExecutor.register('mcp_workspace', (args) => workspaceManager.handleAction(args));
        toolExecutor.aliasMap.workspace = 'mcp_workspace';
      }

      if (this.container.has('toolExecutor') && this.container.has('localManager')) {
        const toolExecutor = this.container.get('toolExecutor');
        const localManager = this.container.get('localManager');
        toolExecutor.register('mcp_local', (args) => localManager.handleAction(args));
        toolExecutor.aliasMap.local = 'mcp_local';
      }

      this.initialized = true;

      if (this.container.has('logger')) {
        const logger = this.container.get('logger');
        logger.info('Service Layer initialized successfully');
      } else {
        process.stdout.write('✅ Service Layer initialized successfully\n');
      }
      return this.container;
      
    } catch (error) {
      if (this.container && this.container.has('logger')) {
        const logger = this.container.get('logger');
        logger.error('Service Layer initialization failed', { error: error.message });
      } else {
        process.stderr.write(`❌ Service Layer initialization failed: ${error.message}\n`);
      }
      throw error;
    }
  }

  static async registerBaseServices() {
    const Logger = require('../services/Logger.cjs');
    const Security = require('../services/Security.cjs');
    const Validation = require('../services/Validation.cjs');
    const ProfileService = require('../services/ProfileService.cjs');
    const VaultClient = require('../services/VaultClient.cjs');
    const SecretRefResolver = require('../services/SecretRefResolver.cjs');
    const StateService = require('../services/StateService.cjs');
    const ProjectService = require('../services/ProjectService.cjs');
    const ProjectResolver = require('../services/ProjectResolver.cjs');
    const RunbookService = require('../services/RunbookService.cjs');
    const ContextService = require('../services/ContextService.cjs');
    const ContextSessionService = require('../services/ContextSessionService.cjs');
    const CapabilityService = require('../services/CapabilityService.cjs');
    const EvidenceService = require('../services/EvidenceService.cjs');
    const AliasService = require('../services/AliasService.cjs');
    const PresetService = require('../services/PresetService.cjs');
    const AuditService = require('../services/AuditService.cjs');
    const CacheService = require('../services/CacheService.cjs');
    const WorkspaceService = require('../services/WorkspaceService.cjs');
    const PolicyService = require('../services/PolicyService.cjs');
    const JobService = require('../services/JobService.cjs');

    // Logger (базовый сервис)
    this.container.register('logger', () => {
      const logger = new Logger('sentryfrogg');
      return logger;
    }, { singleton: true });

    // Security сервис
    this.container.register('security', (logger) => new Security(logger), { 
      singleton: true,
      dependencies: ['logger'] 
    });

    // Job service (unified async registry)
    this.container.register('jobService', (logger) => new JobService(logger), {
      singleton: true,
      dependencies: ['logger'],
    });

    // Validation сервис
    this.container.register('validation', (logger) => new Validation(logger), { 
      singleton: true,
      dependencies: ['logger'] 
    });

    // Profile сервис
    this.container.register('profileService', (logger, security) => 
      new ProfileService(logger, security), { 
      singleton: true,
      dependencies: ['logger', 'security'] 
    });

    // Vault client (KV v2)
    this.container.register('vaultClient', (logger, validation, profileService) =>
      new VaultClient(logger, validation, profileService), {
      singleton: true,
      dependencies: ['logger', 'validation', 'profileService'],
    });

    // State сервис
    this.container.register('stateService', (logger) =>
      new StateService(logger), {
      singleton: true,
      dependencies: ['logger'],
    });

    // Project сервис
    this.container.register('projectService', (logger) =>
      new ProjectService(logger), {
      singleton: true,
      dependencies: ['logger'],
    });

    // Project resolver (project/target → контекст вызова)
    this.container.register('projectResolver', (validation, projectService, stateService) =>
      new ProjectResolver(validation, projectService, stateService), {
      singleton: true,
      dependencies: ['validation', 'projectService', 'stateService'],
    });

    // SecretRef resolver (Vault/ENV refs)
    this.container.register('secretRefResolver', (logger, validation, profileService, vaultClient, projectResolver) =>
      new SecretRefResolver(logger, validation, profileService, vaultClient, projectResolver), {
      singleton: true,
      dependencies: ['logger', 'validation', 'profileService', 'vaultClient', 'projectResolver'],
    });

    // Runbook сервис
    this.container.register('runbookService', (logger) =>
      new RunbookService(logger), {
      singleton: true,
      dependencies: ['logger'],
    });

    // Context сервис
    this.container.register('contextService', (logger, projectResolver) =>
      new ContextService(logger, projectResolver), {
      singleton: true,
      dependencies: ['logger', 'projectResolver'],
    });

    // ContextSession сервис
    this.container.register('contextSessionService', (logger, contextService, projectResolver, profileService) =>
      new ContextSessionService(logger, contextService, projectResolver, profileService), {
      singleton: true,
      dependencies: ['logger', 'contextService', 'projectResolver', 'profileService'],
    });

    // Policy service (GitOps hardening)
    this.container.register('policyService', (logger, validation, stateService) =>
      new PolicyService(logger, validation, stateService), {
      singleton: true,
      dependencies: ['logger', 'validation', 'stateService'],
    });

    // Capability сервис
    this.container.register('capabilityService', (logger, security) =>
      new CapabilityService(logger, security), {
      singleton: true,
      dependencies: ['logger', 'security'],
    });

    // Evidence сервис
    this.container.register('evidenceService', (logger, security) =>
      new EvidenceService(logger, security), {
      singleton: true,
      dependencies: ['logger', 'security'],
    });

    // Alias сервис
    this.container.register('aliasService', (logger) =>
      new AliasService(logger), {
      singleton: true,
      dependencies: ['logger'],
    });

    // Preset сервис
    this.container.register('presetService', (logger) =>
      new PresetService(logger), {
      singleton: true,
      dependencies: ['logger'],
    });

    // Audit сервис
    this.container.register('auditService', (logger) =>
      new AuditService(logger), {
      singleton: true,
      dependencies: ['logger'],
    });

    // Cache сервис
    this.container.register('cacheService', (logger) =>
      new CacheService(logger), {
      singleton: true,
      dependencies: ['logger'],
    });

    // Workspace сервис
    this.container.register('workspaceService',
      (logger, contextService, contextSessionService, projectResolver, profileService, runbookService, capabilityService, projectService, aliasService, presetService, stateService) =>
        new WorkspaceService(
          logger,
          contextService,
          contextSessionService,
          projectResolver,
          profileService,
          runbookService,
          capabilityService,
          projectService,
          aliasService,
          presetService,
          stateService
        ), {
      singleton: true,
      dependencies: [
        'logger',
        'contextService',
        'contextSessionService',
        'projectResolver',
        'profileService',
        'runbookService',
        'capabilityService',
        'projectService',
        'aliasService',
        'presetService',
        'stateService',
      ],
    });
  }

  static async registerManagers() {
    const PostgreSQLManager = require('../managers/PostgreSQLManager.cjs');
    const SSHManager = require('../managers/SSHManager.cjs');
    const APIManager = require('../managers/APIManager.cjs');
    const LocalManager = require('../managers/LocalManager.cjs');
    const RepoManager = require('../managers/RepoManager.cjs');
    const ArtifactManager = require('../managers/ArtifactManager.cjs');
    const StateManager = require('../managers/StateManager.cjs');
    const ProjectManager = require('../managers/ProjectManager.cjs');
    const EnvManager = require('../managers/EnvManager.cjs');
    const VaultManager = require('../managers/VaultManager.cjs');
    const RunbookManager = require('../managers/RunbookManager.cjs');
    const ContextManager = require('../managers/ContextManager.cjs');
    const CapabilityManager = require('../managers/CapabilityManager.cjs');
    const IntentManager = require('../managers/IntentManager.cjs');
    const EvidenceManager = require('../managers/EvidenceManager.cjs');
    const AliasManager = require('../managers/AliasManager.cjs');
    const PresetManager = require('../managers/PresetManager.cjs');
    const AuditManager = require('../managers/AuditManager.cjs');
    const PipelineManager = require('../managers/PipelineManager.cjs');
    const WorkspaceManager = require('../managers/WorkspaceManager.cjs');
    const JobManager = require('../managers/JobManager.cjs');
    const ToolExecutor = require('../services/ToolExecutor.cjs');
    const { isUnsafeLocalEnabled } = require('../utils/featureFlags.cjs');

    // PostgreSQL Manager
    this.container.register('postgresqlManager', 
      (logger, validation, profileService, projectResolver, secretRefResolver) => 
        new PostgreSQLManager(logger, validation, profileService, projectResolver, secretRefResolver), { 
      singleton: true,
      dependencies: ['logger', 'validation', 'profileService', 'projectResolver', 'secretRefResolver'] 
    });

    // SSH Manager
    this.container.register('sshManager', 
      (logger, security, validation, profileService, projectResolver, secretRefResolver, jobService) => 
        new SSHManager(logger, security, validation, profileService, projectResolver, secretRefResolver, jobService), { 
      singleton: true,
      dependencies: ['logger', 'security', 'validation', 'profileService', 'projectResolver', 'secretRefResolver', 'jobService'] 
    });

    // Job Manager (unified job API)
    this.container.register('jobManager',
      (logger, validation, jobService, sshManager) =>
        new JobManager(logger, validation, jobService, { sshManager }), {
      singleton: true,
      dependencies: ['logger', 'validation', 'jobService', 'sshManager'],
    });

    // API Manager
    this.container.register('apiManager', 
      (logger, security, validation, profileService, cacheService, projectResolver, secretRefResolver) => 
        new APIManager(logger, security, validation, profileService, cacheService, { projectResolver, secretRefResolver }), { 
      singleton: true,
      dependencies: ['logger', 'security', 'validation', 'profileService', 'cacheService', 'projectResolver', 'secretRefResolver'] 
    });

    if (isUnsafeLocalEnabled()) {
      this.container.register('localManager',
        (logger, validation) =>
          new LocalManager(logger, validation, { enabled: true }), {
        singleton: true,
        dependencies: ['logger', 'validation'],
      });
    }

    // Repo Manager (safe-by-default)
    this.container.register('repoManager',
      (logger, security, validation, projectResolver, policyService) =>
        new RepoManager(logger, security, validation, projectResolver, policyService), {
      singleton: true,
      dependencies: ['logger', 'security', 'validation', 'projectResolver', 'policyService'],
    });

    // Artifact Manager
    this.container.register('artifactManager',
      (logger, validation) =>
        new ArtifactManager(logger, validation), {
      singleton: true,
      dependencies: ['logger', 'validation'],
    });

    // State Manager
    this.container.register('stateManager',
      (logger, stateService) =>
        new StateManager(logger, stateService), {
      singleton: true,
      dependencies: ['logger', 'stateService'],
    });

    // Project Manager
    this.container.register('projectManager',
      (logger, validation, projectService, stateService) =>
        new ProjectManager(logger, validation, projectService, stateService), {
      singleton: true,
      dependencies: ['logger', 'validation', 'projectService', 'stateService'],
    });

    // Env Manager
    this.container.register('envManager',
      (logger, validation, profileService, sshManager, projectResolver, secretRefResolver) =>
        new EnvManager(logger, validation, profileService, sshManager, projectResolver, secretRefResolver), {
      singleton: true,
      dependencies: ['logger', 'validation', 'profileService', 'sshManager', 'projectResolver', 'secretRefResolver'],
    });

    // Vault Manager
    this.container.register('vaultManager',
      (logger, validation, profileService, vaultClient) =>
        new VaultManager(logger, validation, profileService, vaultClient), {
      singleton: true,
      dependencies: ['logger', 'validation', 'profileService', 'vaultClient'],
    });

    // Context Manager
    this.container.register('contextManager',
      (logger, validation, contextService) =>
        new ContextManager(logger, validation, contextService), {
      singleton: true,
      dependencies: ['logger', 'validation', 'contextService'],
    });

    // Capability Manager
    this.container.register('capabilityManager',
      (logger, security, validation, capabilityService, contextService) =>
        new CapabilityManager(logger, security, validation, capabilityService, contextService), {
      singleton: true,
      dependencies: ['logger', 'security', 'validation', 'capabilityService', 'contextService'],
    });

    // Evidence Manager
    this.container.register('evidenceManager',
      (logger, security, validation, evidenceService) =>
        new EvidenceManager(logger, security, validation, evidenceService), {
      singleton: true,
      dependencies: ['logger', 'security', 'validation', 'evidenceService'],
    });

    // Tool executor
    this.container.register('toolExecutor',
      (logger, stateService, aliasService, presetService, auditService, postgresqlManager, sshManager, jobManager, apiManager, repoManager, artifactManager, stateManager, projectManager, envManager, vaultManager, contextManager, capabilityManager, evidenceManager, aliasManager, presetManager, auditManager, pipelineManager) =>
        new ToolExecutor(logger, stateService, aliasService, presetService, auditService, {
          mcp_psql_manager: (args) => postgresqlManager.handleAction(args),
          mcp_ssh_manager: (args) => sshManager.handleAction(args),
          mcp_jobs: (args) => jobManager.handleAction(args),
          mcp_api_client: (args) => apiManager.handleAction(args),
          mcp_repo: (args) => repoManager.handleAction(args),
          mcp_artifacts: (args) => artifactManager.handleAction(args),
          mcp_state: (args) => stateManager.handleAction(args),
          mcp_project: (args) => projectManager.handleAction(args),
          mcp_env: (args) => envManager.handleAction(args),
          mcp_vault: (args) => vaultManager.handleAction(args),
          mcp_context: (args) => contextManager.handleAction(args),
          mcp_capability: (args) => capabilityManager.handleAction(args),
          mcp_evidence: (args) => evidenceManager.handleAction(args),
          mcp_alias: (args) => aliasManager.handleAction(args),
          mcp_preset: (args) => presetManager.handleAction(args),
          mcp_audit: (args) => auditManager.handleAction(args),
          mcp_pipeline: (args) => pipelineManager.handleAction(args),
        }, {
          aliasMap: {
            sql: 'mcp_psql_manager',
            psql: 'mcp_psql_manager',
            ssh: 'mcp_ssh_manager',
            job: 'mcp_jobs',
            http: 'mcp_api_client',
            api: 'mcp_api_client',
            repo: 'mcp_repo',
            artifacts: 'mcp_artifacts',
            state: 'mcp_state',
            project: 'mcp_project',
            env: 'mcp_env',
            vault: 'mcp_vault',
            context: 'mcp_context',
            capability: 'mcp_capability',
            evidence: 'mcp_evidence',
            runbook: 'mcp_runbook',
            alias: 'mcp_alias',
            preset: 'mcp_preset',
            audit: 'mcp_audit',
            pipeline: 'mcp_pipeline',
          },
        }), {
      singleton: true,
      dependencies: [
        'logger',
        'stateService',
        'aliasService',
        'presetService',
        'auditService',
        'postgresqlManager',
        'sshManager',
        'jobManager',
        'apiManager',
        'repoManager',
        'artifactManager',
        'stateManager',
        'projectManager',
        'envManager',
        'vaultManager',
        'contextManager',
        'capabilityManager',
        'evidenceManager',
        'aliasManager',
        'presetManager',
        'auditManager',
        'pipelineManager',
      ],
    });

    // Runbook Manager
    this.container.register('runbookManager',
      (logger, runbookService, stateService, toolExecutor) =>
        new RunbookManager(logger, runbookService, stateService, toolExecutor), {
      singleton: true,
      dependencies: ['logger', 'runbookService', 'stateService', 'toolExecutor'],
    });

    // Intent Manager
    this.container.register('intentManager',
      (logger, security, validation, capabilityService, runbookManager, evidenceService, projectResolver, contextService, policyService) =>
        new IntentManager(logger, security, validation, capabilityService, runbookManager, evidenceService, projectResolver, contextService, policyService), {
      singleton: true,
      dependencies: [
        'logger',
        'security',
        'validation',
        'capabilityService',
        'runbookManager',
        'evidenceService',
        'projectResolver',
        'contextService',
        'policyService',
      ],
    });

    // Workspace Manager
    this.container.register('workspaceManager',
      (logger, validation, workspaceService, runbookManager, intentManager, sshManager) =>
        new WorkspaceManager(logger, validation, workspaceService, runbookManager, intentManager, sshManager), {
      singleton: true,
      dependencies: ['logger', 'validation', 'workspaceService', 'runbookManager', 'intentManager', 'sshManager'],
    });

    // Alias Manager
    this.container.register('aliasManager',
      (logger, aliasService) =>
        new AliasManager(logger, aliasService), {
      singleton: true,
      dependencies: ['logger', 'aliasService'],
    });

    // Preset Manager
    this.container.register('presetManager',
      (logger, presetService) =>
        new PresetManager(logger, presetService), {
      singleton: true,
      dependencies: ['logger', 'presetService'],
    });

    // Audit Manager
    this.container.register('auditManager',
      (logger, auditService) =>
        new AuditManager(logger, auditService), {
      singleton: true,
      dependencies: ['logger', 'auditService'],
    });

    // Pipeline Manager
    this.container.register('pipelineManager',
      (logger, validation, apiManager, sshManager, postgresqlManager, cacheService, auditService, projectResolver) =>
        new PipelineManager(logger, validation, apiManager, sshManager, postgresqlManager, cacheService, auditService, projectResolver), {
      singleton: true,
      dependencies: ['logger', 'validation', 'apiManager', 'sshManager', 'postgresqlManager', 'cacheService', 'auditService', 'projectResolver'],
    });
  }

  static async cleanup() {
    if (!this.initialized) {
      return;
    }

    try {
      // Cleanup всех сервисов
      for (const [name, instance] of this.container.singletons) {
        if (instance && typeof instance.cleanup === 'function') {
          await instance.cleanup();
        }
      }

      this.container.services.clear();
      this.container.singletons.clear();
      this.container = null;
      this.initialized = false;
      
      process.stdout.write('✅ Service Layer cleanup completed\n');
      
    } catch (error) {
      process.stderr.write(`❌ Service Layer cleanup failed: ${error.message}\n`);
      throw error;
    }
  }

  static getStats() {
    if (!this.initialized) {
      return { error: 'Service Layer not initialized' };
    }

    return {
      initialized: this.initialized,
      ...this.container.getStats()
    };
  }
}

module.exports = ServiceBootstrap; 
