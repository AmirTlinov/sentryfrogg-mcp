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
  }

  static async registerManagers() {
    const PostgreSQLManager = require('../managers/PostgreSQLManager.cjs');
    const SSHManager = require('../managers/SSHManager.cjs');
    const APIManager = require('../managers/APIManager.cjs');

    // PostgreSQL Manager
    this.container.register('postgresqlManager', 
      (logger, security, validation, profileService) => 
        new PostgreSQLManager(logger, security, validation, profileService), { 
      singleton: true,
      dependencies: ['logger', 'security', 'validation', 'profileService'] 
    });

    // SSH Manager
    this.container.register('sshManager', 
      (logger, security, validation, profileService) => 
        new SSHManager(logger, security, validation, profileService), { 
      singleton: true,
      dependencies: ['logger', 'security', 'validation', 'profileService'] 
    });

    // API Manager
    this.container.register('apiManager', 
      (logger, security, validation) => 
        new APIManager(logger, security, validation), { 
      singleton: true,
      dependencies: ['logger', 'security', 'validation'] 
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
