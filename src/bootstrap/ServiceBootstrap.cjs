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
    const StateService = require('../services/StateService.cjs');
    const ProjectService = require('../services/ProjectService.cjs');
    const ProjectResolver = require('../services/ProjectResolver.cjs');
    const RunbookService = require('../services/RunbookService.cjs');
    const AliasService = require('../services/AliasService.cjs');
    const PresetService = require('../services/PresetService.cjs');
    const AuditService = require('../services/AuditService.cjs');
    const CacheService = require('../services/CacheService.cjs');

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

    // Runbook сервис
    this.container.register('runbookService', (logger) =>
      new RunbookService(logger), {
      singleton: true,
      dependencies: ['logger'],
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
  }

  static async registerManagers() {
    const PostgreSQLManager = require('../managers/PostgreSQLManager.cjs');
    const SSHManager = require('../managers/SSHManager.cjs');
    const APIManager = require('../managers/APIManager.cjs');
    const LocalManager = require('../managers/LocalManager.cjs');
    const StateManager = require('../managers/StateManager.cjs');
    const ProjectManager = require('../managers/ProjectManager.cjs');
    const EnvManager = require('../managers/EnvManager.cjs');
    const RunbookManager = require('../managers/RunbookManager.cjs');
    const AliasManager = require('../managers/AliasManager.cjs');
    const PresetManager = require('../managers/PresetManager.cjs');
    const AuditManager = require('../managers/AuditManager.cjs');
    const PipelineManager = require('../managers/PipelineManager.cjs');
    const ToolExecutor = require('../services/ToolExecutor.cjs');
    const { isUnsafeLocalEnabled } = require('../utils/featureFlags.cjs');

    // PostgreSQL Manager
    this.container.register('postgresqlManager', 
      (logger, validation, profileService, projectResolver) => 
        new PostgreSQLManager(logger, validation, profileService, projectResolver), { 
      singleton: true,
      dependencies: ['logger', 'validation', 'profileService', 'projectResolver'] 
    });

    // SSH Manager
    this.container.register('sshManager', 
      (logger, security, validation, profileService, projectResolver) => 
        new SSHManager(logger, security, validation, profileService, projectResolver), { 
      singleton: true,
      dependencies: ['logger', 'security', 'validation', 'profileService', 'projectResolver'] 
    });

    // API Manager
    this.container.register('apiManager', 
      (logger, security, validation, profileService, cacheService, projectResolver) => 
        new APIManager(logger, security, validation, profileService, cacheService, { projectResolver }), { 
      singleton: true,
      dependencies: ['logger', 'security', 'validation', 'profileService', 'cacheService', 'projectResolver'] 
    });

    if (isUnsafeLocalEnabled()) {
      this.container.register('localManager',
        (logger, validation) =>
          new LocalManager(logger, validation, { enabled: true }), {
        singleton: true,
        dependencies: ['logger', 'validation'],
      });
    }

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
      (logger, validation, profileService, sshManager, projectResolver) =>
        new EnvManager(logger, validation, profileService, sshManager, projectResolver), {
      singleton: true,
      dependencies: ['logger', 'validation', 'profileService', 'sshManager', 'projectResolver'],
    });

    // Tool executor
    this.container.register('toolExecutor',
      (logger, stateService, aliasService, presetService, auditService, postgresqlManager, sshManager, apiManager, stateManager, projectManager, envManager, aliasManager, presetManager, auditManager, pipelineManager) =>
        new ToolExecutor(logger, stateService, aliasService, presetService, auditService, {
          mcp_psql_manager: (args) => postgresqlManager.handleAction(args),
          mcp_ssh_manager: (args) => sshManager.handleAction(args),
          mcp_api_client: (args) => apiManager.handleAction(args),
          mcp_state: (args) => stateManager.handleAction(args),
          mcp_project: (args) => projectManager.handleAction(args),
          mcp_env: (args) => envManager.handleAction(args),
          mcp_alias: (args) => aliasManager.handleAction(args),
          mcp_preset: (args) => presetManager.handleAction(args),
          mcp_audit: (args) => auditManager.handleAction(args),
          mcp_pipeline: (args) => pipelineManager.handleAction(args),
        }, {
          aliasMap: {
            sql: 'mcp_psql_manager',
            psql: 'mcp_psql_manager',
            ssh: 'mcp_ssh_manager',
            http: 'mcp_api_client',
            api: 'mcp_api_client',
            state: 'mcp_state',
            project: 'mcp_project',
            env: 'mcp_env',
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
        'apiManager',
        'stateManager',
        'projectManager',
        'envManager',
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
