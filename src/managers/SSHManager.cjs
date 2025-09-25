#!/usr/bin/env node

/**
 * 🔐 SSH менеджер с поддержкой пароля и приватного ключа.
 */

const { Client } = require('ssh2');
const Constants = require('../constants/Constants.cjs');

function profileKey(profileName) {
  return profileName;
}

class SSHManager {
  constructor(logger, security, validation, profileService) {
    this.logger = logger.child('ssh');
    this.security = security;
    this.validation = validation;
    this.profileService = profileService;
    this.connections = new Map();
    this.stats = {
      commands: 0,
      profiles_created: 0,
      errors: 0,
    };
  }

  async handleAction(args = {}) {
    const { action, profile_name = 'default' } = args;

    switch (action) {
      case 'setup_profile':
        return this.setupProfile(profile_name, args);
      case 'list_profiles':
        return this.listProfiles();
      case 'execute':
        return this.executeCommand(profile_name, args.command);
      case 'system_info':
        return this.systemInfo(profile_name);
      case 'check_host':
        return this.checkHost(profile_name);
      default:
        throw new Error(`Unknown SSH action: ${action}`);
    }
  }

  async setupProfile(name, params) {
    const base = this.validation.ensureConnectionProfile(
      {
        host: params.host,
        port: params.port,
        username: params.username,
        password: params.password,
      },
      { defaultPort: Constants.NETWORK.SSH_DEFAULT_PORT, requirePassword: false }
    );

    const secrets = {
      password: params.password,
      private_key: params.private_key,
      passphrase: params.passphrase,
    };

    if (!secrets.password && !secrets.private_key) {
      throw new Error('Provide password or private_key for SSH profile');
    }

    const finalProfile = {
      ...base,
      type: 'ssh',
      ready_timeout: params.ready_timeout,
      keepalive_interval: params.keepalive_interval,
      ...secrets,
    };

    await this.testConnection(finalProfile);
    await this.profileService.setProfile(name, finalProfile);
    this.stats.profiles_created += 1;

    return {
      success: true,
      message: `SSH profile '${name}' saved`,
      profile: {
        name,
        host: finalProfile.host,
        port: finalProfile.port,
        username: finalProfile.username,
        auth: finalProfile.private_key ? 'private_key' : 'password',
      },
    };
  }

  async listProfiles() {
    const profiles = await this.profileService.listProfiles('ssh');
    return { success: true, profiles };
  }

  buildConnectConfig(profile) {
    const config = {
      host: profile.host,
      port: profile.port,
      username: profile.username,
      readyTimeout: profile.ready_timeout ?? Constants.NETWORK.TIMEOUT_SSH_READY,
      keepaliveInterval: profile.keepalive_interval ?? Constants.NETWORK.KEEPALIVE_INTERVAL,
    };

    if (profile.private_key) {
      config.privateKey = profile.private_key;
      if (profile.passphrase) {
        config.passphrase = profile.passphrase;
      }
    } else if (profile.password) {
      config.password = profile.password;
    }

    return config;
  }

  async executeCommand(profileName, command) {
    const cleaned = this.security.cleanCommand(command);

    try {
      const result = await this.withClient(profileName, async (client) => this.exec(client, cleaned));
      this.stats.commands += 1;
      return { success: true, command: cleaned, output: result.stdout, error: result.stderr, exitCode: result.exitCode };
    } catch (error) {
      this.stats.errors += 1;
      this.logger.error('SSH command failed', { profile: profileName, error: error.message });
      throw error;
    }
  }

  async systemInfo(profileName) {
    const commands = {
      uname: 'uname -a',
      os: 'cat /etc/os-release 2>/dev/null || sw_vers 2>/dev/null || echo "OS info unavailable"',
      disk: 'df -h',
      memory: 'free -h 2>/dev/null || vm_stat',
      uptime: 'uptime',
    };

    const report = {};
    await this.withClient(profileName, async (client) => {
      for (const [key, cmd] of Object.entries(commands)) {
        try {
          const result = await this.exec(client, cmd);
          report[key] = { success: true, ...result };
        } catch (error) {
          report[key] = { success: false, error: error.message };
        }
      }
    });

    return { success: true, system_info: report };
  }

  async checkHost(profileName) {
    try {
      const result = await this.withClient(profileName, async (client) => this.exec(client, 'echo "Connection OK" && whoami && hostname'));
      return { success: true, response: result.stdout };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async withClient(profileName, handler) {
    const profile = await this.profileService.getProfile(profileName, 'ssh');
    const key = profileKey(profileName);

    let entry = this.connections.get(key);
    if (!entry || entry.closed) {
      entry = await this.createClient(profile, key);
      this.connections.set(key, entry);
    }

    while (entry.busy) {
      await entry.busy;
    }

    let release;
    entry.busy = new Promise((resolve) => {
      release = resolve;
    });

    try {
      return await handler(entry.client);
    } finally {
      release();
      entry.busy = null;
    }
  }

  async createClient(profile, key) {
    return new Promise((resolve, reject) => {
      const client = new Client();
      let resolved = false;
      const connectConfig = this.buildConnectConfig(profile);

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          client.destroy();
          reject(new Error('SSH connection timeout'));
        }
      }, connectConfig.readyTimeout ?? Constants.NETWORK.TIMEOUT_SSH_READY);

      const finalize = (fn) => (value) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          fn(value);
        }
      };

      client
        .on('ready', finalize(() => {
          client.on('close', () => {
            const entry = this.connections.get(key);
            if (entry) {
              entry.closed = true;
              this.connections.delete(key);
            }
          });
          resolve({ client, busy: null, closed: false });
        }))
        .on('error', finalize((error) => {
          client.destroy();
          reject(error);
        }));

      client.connect(connectConfig);
    });
  }

  exec(client, command) {
    return new Promise((resolve, reject) => {
      client.exec(command, (error, stream) => {
        if (error) {
          reject(error);
          return;
        }

        let stdout = '';
        let stderr = '';

        stream
          .on('close', (code) => {
            resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: code });
          })
          .on('error', reject)
          .on('data', (data) => {
            stdout += data.toString();
          });

        stream.stderr.on('data', (data) => {
          stderr += data.toString();
        });
      });
    });
  }

  async testConnection(profile) {
    const entry = await this.createClient(profile, Symbol('test'));
    try {
      await this.exec(entry.client, 'echo "test"');
    } finally {
      entry.client.end();
    }
  }

  getStats() {
    return { ...this.stats, active_connections: this.connections.size };
  }

  async cleanup() {
    for (const entry of this.connections.values()) {
      try {
        entry.client.end();
      } catch (error) {
        // ignore cleanup errors
      }
    }
    this.connections.clear();
  }
}

module.exports = SSHManager;
