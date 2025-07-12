#!/usr/bin/env node

/**
 * 👤 PROFILE SERVICE
 * Управление профилями подключения с шифрованием паролей
 */

const fs = require('fs').promises;
const path = require('path');

class ProfileService {
  constructor(logger, security) {
    this.logger = logger;
    this.security = security;
    this.profiles = new Map();
    this.profilesFile = path.join(process.cwd(), 'profiles.json');
    this.stats = {
      created: 0,
      loaded: 0,
      saved: 0,
      errors: 0
    };
  }

  // Инициализация сервиса
  async initialize() {
    try {
      await this.loadProfiles();
      this.logger.info('Profile service initialized');
    } catch (error) {
      this.logger.error('Failed to initialize profile service', { error: error.message });
      throw error;
    }
  }

  // Загрузка профилей из файла
  async loadProfiles() {
    try {
      const data = await fs.readFile(this.profilesFile, 'utf8');
      const profiles = JSON.parse(data);
      
      for (const [name, profile] of Object.entries(profiles)) {
        this.profiles.set(name, profile);
      }
      
      this.stats.loaded = this.profiles.size;
      this.logger.info(`Loaded ${this.profiles.size} profiles`);
      
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.logger.info('No profiles file found, starting with empty profiles');
        this.profiles.clear();
      } else {
        this.logger.error('Failed to load profiles', { error: error.message });
        throw error;
      }
    }
  }

  // Сохранение профилей в файл
  async saveProfiles() {
    try {
      const profiles = Object.fromEntries(this.profiles);
      const data = JSON.stringify(profiles, null, 2);
      
      await fs.writeFile(this.profilesFile, data, 'utf8');
      this.stats.saved++;
      this.logger.info('Profiles saved successfully');
      
    } catch (error) {
      this.stats.errors++;
      this.logger.error('Failed to save profiles', { error: error.message });
      throw error;
    }
  }

  // Создание/обновление профиля
  async setProfile(name, config) {
    try {
      if (!name || typeof name !== 'string') {
        throw new Error('Profile name must be a non-empty string');
      }

      if (!config || typeof config !== 'object') {
        throw new Error('Profile config must be an object');
      }

      // Создание копии конфигурации
      const profile = { ...config };

      // Шифрование пароля
      if (profile.password) {
        profile.password = await this.security.encrypt(profile.password);
        profile.encrypted = true;
      }

      // Добавление метаданных
      profile.created_at = profile.created_at || new Date().toISOString();
      profile.updated_at = new Date().toISOString();

      this.profiles.set(name, profile);
      await this.saveProfiles();
      
      this.stats.created++;
      this.logger.info('Profile created/updated', { name, host: profile.host });
      
      return { success: true, message: `Profile '${name}' saved successfully` };
      
    } catch (error) {
      this.stats.errors++;
      this.logger.error('Failed to set profile', { name, error: error.message });
      throw error;
    }
  }

  // Получение профиля с расшифровкой пароля
  async getProfile(name) {
    try {
      if (!name || typeof name !== 'string') {
        throw new Error('Profile name must be a non-empty string');
      }

      const profile = this.profiles.get(name);
      if (!profile) {
        throw new Error(`Profile '${name}' not found`);
      }

      // Создание копии профиля
      const result = { ...profile };

      // Расшифровка пароля
      if (result.encrypted && result.password) {
        try {
          result.password = await this.security.decrypt(result.password);
          delete result.encrypted;
        } catch (error) {
          this.logger.error('Failed to decrypt password', { name, error: error.message });
          throw new Error('Failed to decrypt profile password');
        }
      }

      this.logger.debug('Profile retrieved', { name, host: result.host });
      return result;
      
    } catch (error) {
      this.stats.errors++;
      this.logger.error('Failed to get profile', { name, error: error.message });
      throw error;
    }
  }

  // Получение списка профилей (без паролей)
  async listProfiles() {
    try {
      const profiles = [];
      
      for (const [name, profile] of this.profiles) {
        profiles.push({
          name,
          host: profile.host,
          port: profile.port,
          username: profile.username,
          database: profile.database,
          created_at: profile.created_at,
          updated_at: profile.updated_at
        });
      }
      
      this.logger.debug('Profiles listed', { count: profiles.length });
      return profiles;
      
    } catch (error) {
      this.stats.errors++;
      this.logger.error('Failed to list profiles', { error: error.message });
      throw error;
    }
  }

  // Удаление профиля
  async deleteProfile(name) {
    try {
      if (!name || typeof name !== 'string') {
        throw new Error('Profile name must be a non-empty string');
      }

      if (!this.profiles.has(name)) {
        throw new Error(`Profile '${name}' not found`);
      }

      this.profiles.delete(name);
      await this.saveProfiles();
      
      this.logger.info('Profile deleted', { name });
      return { success: true, message: `Profile '${name}' deleted successfully` };
      
    } catch (error) {
      this.stats.errors++;
      this.logger.error('Failed to delete profile', { name, error: error.message });
      throw error;
    }
  }

  // Проверка существования профиля
  hasProfile(name) {
    return this.profiles.has(name);
  }

  // Получение статистики
  getStats() {
    return {
      ...this.stats,
      total_profiles: this.profiles.size
    };
  }

  // Очистка сервиса
  async cleanup() {
    try {
      // Очистка профилей из памяти
      this.profiles.clear();
      this.logger.info('Profile service cleaned up');
    } catch (error) {
      this.logger.error('Failed to cleanup profile service', { error: error.message });
      throw error;
    }
  }
}

function createProfileService(logger, security) {
  const service = new ProfileService(logger, security);
  // Возвращаем прокси для автоматической инициализации
  return new Proxy(service, {
    get(target, prop) {
      if (prop === 'initialize' || prop === 'constructor') {
        return target[prop];
      }
      
      // Автоматическая инициализация при первом обращении
      if (!target._initialized) {
        target._initialized = true;
        target.initialize().catch(error => {
          target.logger.error('Auto-initialization failed', { error: error.message });
        });
      }
      
      return target[prop];
    }
  });
}

module.exports = ProfileService; 