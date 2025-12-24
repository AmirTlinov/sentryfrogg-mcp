#!/usr/bin/env node

/**
 * 🔐 SSH manager.
 */

const fs = require('fs/promises');
const path = require('path');
const { Client } = require('ssh2');
const Constants = require('../constants/Constants.cjs');

function profileKey(profileName) {
  return profileName;
}

function escapeShellValue(value) {
  const str = String(value);
  return `'${str.replace(/'/g, "'\\''")}'`;
}

class SSHManager {
  constructor(logger, security, validation, profileService, projectResolver) {
    this.logger = logger.child('ssh');
    this.security = security;
    this.validation = validation;
    this.profileService = profileService;
    this.projectResolver = projectResolver;
    this.connections = new Map();
    this.stats = {
      commands: 0,
      profiles_created: 0,
      errors: 0,
      sftp_ops: 0,
    };
  }

  async handleAction(args = {}) {
    const { action } = args;

    switch (action) {
      case 'profile_upsert':
        return this.profileUpsert(args.profile_name, args);
      case 'profile_get':
        return this.profileGet(args.profile_name, args.include_secrets);
      case 'profile_list':
        return this.profileList();
      case 'profile_delete':
        return this.profileDelete(args.profile_name);
      case 'profile_test':
        return this.profileTest(args);
      case 'exec':
        return this.execCommand(args);
      case 'batch':
        return this.batch(args);
      case 'system_info':
        return this.systemInfo(args);
      case 'check_host':
        return this.checkHost(args);
      case 'sftp_list':
        return this.sftpList(args);
      case 'sftp_upload':
        return this.sftpUpload(args);
      case 'sftp_download':
        return this.sftpDownload(args);
      default:
        throw new Error(`Unknown SSH action: ${action}`);
    }
  }

  async loadPrivateKey(connection) {
    if (connection.private_key) {
      return connection.private_key;
    }

    if (connection.private_key_path) {
      return fs.readFile(connection.private_key_path, 'utf8');
    }

    return undefined;
  }

  async resolveConnection(args) {
    if (args.connection) {
      return { connection: { ...args.connection }, profileName: undefined };
    }

    const profileName = await this.resolveProfileName(args.profile_name, args);
    if (!profileName) {
      throw new Error('SSH connection requires profile_name or connection');
    }

    const profile = await this.profileService.getProfile(profileName, 'ssh');
    const data = { ...(profile.data || {}) };
    const secrets = { ...(profile.secrets || {}) };

    if (secrets.password) {
      data.password = secrets.password;
    }
    if (secrets.private_key) {
      data.private_key = secrets.private_key;
    }
    if (secrets.passphrase) {
      data.passphrase = secrets.passphrase;
    }

    return { connection: data, profileName };
  }

  buildConnectConfig(connection) {
    const config = {
      host: connection.host,
      port: this.validation.ensurePort(connection.port, Constants.NETWORK.SSH_DEFAULT_PORT),
      username: connection.username,
      readyTimeout: connection.ready_timeout ?? Constants.NETWORK.TIMEOUT_SSH_READY,
      keepaliveInterval: connection.keepalive_interval ?? Constants.NETWORK.KEEPALIVE_INTERVAL,
    };

    if (connection.keepalive_count_max !== undefined) {
      config.keepaliveCountMax = connection.keepalive_count_max;
    }

    return config;
  }

  async materializeConnection(connection) {
    const config = this.buildConnectConfig(connection);

    const privateKey = await this.loadPrivateKey(connection);
    if (privateKey) {
      config.privateKey = privateKey;
      if (connection.passphrase) {
        config.passphrase = connection.passphrase;
      }
    } else if (connection.password) {
      config.password = connection.password;
    } else {
      throw new Error('Provide password or private_key for SSH connection');
    }

    return config;
  }

  async profileUpsert(profileName, params) {
    const name = this.validation.ensureString(profileName, 'Profile name');
    const connection = params.connection || {};

    const secrets = {
      password: connection.password,
      private_key: connection.private_key,
      passphrase: connection.passphrase,
    };

    const data = { ...connection };
    delete data.password;
    delete data.private_key;
    delete data.passphrase;

    await this.profileTest({ connection });
    await this.profileService.setProfile(name, {
      type: 'ssh',
      data,
      secrets,
    });
    this.stats.profiles_created += 1;

    return {
      success: true,
      profile: {
        name,
        ...data,
        auth: secrets.private_key ? 'private_key' : 'password',
      },
    };
  }

  async resolveProfileName(profileName, args = {}) {
    if (profileName) {
      return this.validation.ensureString(profileName, 'Profile name');
    }

    if (this.projectResolver) {
      const context = await this.projectResolver.resolveContext(args);
      const sshProfile = context?.target?.ssh_profile;
      if (!sshProfile) {
        if (context) {
          throw new Error(`Project target '${context.targetName}' is missing ssh_profile`);
        }
      } else {
        return this.validation.ensureString(String(sshProfile), 'Profile name');
      }
    }

    const profiles = await this.profileService.listProfiles('ssh');
    if (profiles.length === 1) {
      return profiles[0].name;
    }

    if (profiles.length === 0) {
      return undefined;
    }

    throw new Error('profile_name is required when multiple profiles exist');
  }

  async profileGet(profileName, includeSecrets = false) {
    const name = this.validation.ensureString(profileName, 'Profile name');
    const profile = await this.profileService.getProfile(name, 'ssh');
    return {
      success: true,
      profile: includeSecrets ? profile : { name: profile.name, type: profile.type, data: profile.data },
    };
  }

  async profileList() {
    const profiles = await this.profileService.listProfiles('ssh');
    return { success: true, profiles };
  }

  async profileDelete(profileName) {
    const name = this.validation.ensureString(profileName, 'Profile name');
    await this.profileService.deleteProfile(name);
    this.connections.delete(profileKey(name));
    return { success: true, profile: name };
  }

  async profileTest(args) {
    const { connection } = await this.resolveConnection(args);
    const entry = await this.createClient(await this.materializeConnection(connection), Symbol('test'));
    try {
      await this.exec(entry.client, 'echo "test"');
    } finally {
      entry.client.end();
    }
    return { success: true };
  }

  async withClient(profileName, handler) {
    const profile = await this.profileService.getProfile(profileName, 'ssh');
    const key = profileKey(profileName);

    let entry = this.connections.get(key);
    if (!entry || entry.closed) {
      const connection = this.mergeProfile(profile);
      entry = await this.createClient(await this.materializeConnection(connection), key);
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

  mergeProfile(profile) {
    const connection = { ...(profile.data || {}) };
    const secrets = { ...(profile.secrets || {}) };

    if (secrets.password) {
      connection.password = secrets.password;
    }
    if (secrets.private_key) {
      connection.private_key = secrets.private_key;
    }
    if (secrets.passphrase) {
      connection.passphrase = secrets.passphrase;
    }

    return connection;
  }

  async createClient(connectConfig, key) {
    return new Promise((resolve, reject) => {
      const client = new Client();
      let resolved = false;

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

  async getSftp(client) {
    return new Promise((resolve, reject) => {
      client.sftp((error, sftp) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(sftp);
      });
    });
  }

  async withSftp(args, handler) {
    const { connection, profileName } = await this.resolveConnection(args);
    if (profileName) {
      return this.withClient(profileName, async (client) => {
        const sftp = await this.getSftp(client);
        return handler(sftp);
      });
    }

    const entry = await this.createClient(await this.materializeConnection(connection), Symbol('sftp-inline'));
    try {
      const sftp = await this.getSftp(entry.client);
      return await handler(sftp);
    } finally {
      entry.client.end();
    }
  }

  async ensureRemoteDir(sftp, remotePath) {
    const dir = path.posix.dirname(remotePath);
    if (!dir || dir === '.' || dir === '/') {
      return;
    }
    const parts = dir.split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
      current += `/${part}`;
      try {
        await new Promise((resolve, reject) => {
          sftp.stat(current, (error) => {
            if (!error) {
              resolve();
            } else if (error.code === 2) {
              sftp.mkdir(current, (mkdirError) => {
                if (mkdirError && mkdirError.code !== 4) {
                  reject(mkdirError);
                } else {
                  resolve();
                }
              });
            } else {
              reject(error);
            }
          });
        });
      } catch (error) {
        if (error.code !== 4) {
          throw error;
        }
      }
    }
  }

  buildCommand(command, cwd) {
    const trimmed = this.security.cleanCommand(command);
    if (cwd) {
      return `cd ${escapeShellValue(cwd)} && ${trimmed}`;
    }
    return trimmed;
  }

  async execCommand(args) {
    const { connection, profileName } = await this.resolveConnection(args);
    const command = this.buildCommand(args.command, args.cwd);

    const options = {
      env: args.env,
      pty: args.pty,
    };

    try {
      const result = profileName
        ? await this.withClient(profileName, (client) => this.exec(client, command, options, args))
        : await this.execOnce(connection, command, options, args);

      this.stats.commands += 1;
      return { success: result.exitCode === 0, command, ...result };
    } catch (error) {
      this.stats.errors += 1;
      this.logger.error('SSH command failed', { profile: profileName, error: error.message });
      throw error;
    }
  }

  async execOnce(connection, command, options, args) {
    const connectConfig = await this.materializeConnection(connection);
    const entry = await this.createClient(connectConfig, Symbol('inline'));
    try {
      return await this.exec(entry.client, command, options, args);
    } finally {
      entry.client.end();
    }
  }

  exec(client, command, options = {}, args = {}) {
    const timeoutMs = args.timeout_ms;
    const stdin = args.stdin;

    return new Promise((resolve, reject) => {
      const started = Date.now();
      let stdout = '';
      let stderr = '';
      let timedOut = false;

      client.exec(command, options, (error, stream) => {
        if (error) {
          reject(error);
          return;
        }

        let timeout;
        if (timeoutMs) {
          timeout = setTimeout(() => {
            timedOut = true;
            stream.close();
          }, timeoutMs);
        }

        stream
          .on('close', (code, signal) => {
            if (timeout) {
              clearTimeout(timeout);
            }
            resolve({
              stdout: stdout.trim(),
              stderr: stderr.trim(),
              exitCode: code,
              signal,
              timedOut,
              duration_ms: Date.now() - started,
            });
          })
          .on('error', reject)
          .on('data', (data) => {
            stdout += data.toString();
          });

        stream.stderr.on('data', (data) => {
          stderr += data.toString();
        });

        if (stdin !== undefined && stdin !== null) {
          stream.end(String(stdin));
        }
      });
    });
  }

  async batch(args) {
    const commands = Array.isArray(args.commands) ? args.commands : [];
    if (commands.length === 0) {
      throw new Error('commands must be a non-empty array');
    }

    const parallel = !!args.parallel;
    const stopOnError = args.stop_on_error !== false;

    if (parallel) {
      const results = await Promise.all(
        commands.map((command) => this.execCommand({ ...args, ...command }))
      );
      return { success: results.every((item) => item.exitCode === 0), results };
    }

    const results = [];
    for (const command of commands) {
      try {
        const result = await this.execCommand({ ...args, ...command });
        results.push(result);
        if (stopOnError && result.exitCode !== 0) {
          break;
        }
      } catch (error) {
        results.push({ success: false, command: command.command, error: error.message });
        if (stopOnError) {
          break;
        }
      }
    }

    return { success: results.every((item) => item.exitCode === 0), results };
  }

  async sftpList(args) {
    const remotePath = this.validation.ensureString(args.path || '.', 'Path');
    const recursive = args.recursive === true;
    const maxDepth = Number.isInteger(args.max_depth) ? args.max_depth : 3;

    const entries = [];

    const walk = (sftp, currentPath, depth) => new Promise((resolve, reject) => {
      sftp.readdir(currentPath, (error, list) => {
        if (error) {
          reject(error);
          return;
        }
        const run = async () => {
          for (const entry of list) {
            const isDir = entry.attrs && typeof entry.attrs.isDirectory === 'function'
              ? entry.attrs.isDirectory()
              : (entry.attrs?.mode & 0o40000) === 0o40000;
            const fullPath = path.posix.join(currentPath, entry.filename);
            entries.push({
              path: fullPath,
              filename: entry.filename,
              longname: entry.longname,
              type: isDir ? 'dir' : 'file',
              size: entry.attrs?.size,
              mode: entry.attrs?.mode,
              mtime: entry.attrs?.mtime,
              atime: entry.attrs?.atime,
            });
            if (recursive && isDir && depth < maxDepth) {
              await walk(sftp, fullPath, depth + 1);
            }
          }
        };

        run().then(resolve).catch(reject);
      });
    });

    await this.withSftp(args, async (sftp) => {
      await walk(sftp, remotePath, 0);
    });

    this.stats.sftp_ops += 1;
    return { success: true, path: remotePath, entries };
  }

  async sftpUpload(args) {
    const localPath = this.validation.ensureString(args.local_path, 'local_path');
    const remotePath = this.validation.ensureString(args.remote_path, 'remote_path');
    const overwrite = args.overwrite === true;

    await this.withSftp(args, async (sftp) => {
      if (!overwrite) {
        await new Promise((resolve, reject) => {
          sftp.stat(remotePath, (error) => {
            if (!error) {
              reject(new Error(`Remote path already exists: ${remotePath}`));
              return;
            }
            if (error.code !== 2) {
              reject(error);
              return;
            }
            resolve();
          });
        });
      }

      if (args.mkdirs) {
        await this.ensureRemoteDir(sftp, remotePath);
      }

      await new Promise((resolve, reject) => {
        sftp.fastPut(localPath, remotePath, (error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });

      if (args.preserve_mtime) {
        const stat = await fs.stat(localPath);
        await new Promise((resolve, reject) => {
          sftp.utimes(remotePath, stat.atime, stat.mtime, (error) => {
            if (error) {
              reject(error);
            } else {
              resolve();
            }
          });
        });
      }
    });

    this.stats.sftp_ops += 1;
    return { success: true, local_path: localPath, remote_path: remotePath };
  }

  async sftpDownload(args) {
    const remotePath = this.validation.ensureString(args.remote_path, 'remote_path');
    const localPath = this.validation.ensureString(args.local_path, 'local_path');
    const overwrite = args.overwrite === true;

    if (!overwrite) {
      try {
        await fs.access(localPath);
        throw new Error(`Local path already exists: ${localPath}`);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      }
    }

    if (args.mkdirs) {
      await fs.mkdir(path.dirname(localPath), { recursive: true });
    }

    await this.withSftp(args, async (sftp) => {
      await new Promise((resolve, reject) => {
        sftp.fastGet(remotePath, localPath, (error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });

      if (args.preserve_mtime) {
        await new Promise((resolve, reject) => {
          sftp.stat(remotePath, (error, stat) => {
            if (error) {
              reject(error);
            } else {
              fs.utimes(localPath, stat.atime, stat.mtime)
                .then(resolve)
                .catch(reject);
            }
          });
        });
      }
    });

    this.stats.sftp_ops += 1;
    return { success: true, remote_path: remotePath, local_path: localPath };
  }

  async systemInfo(args) {
    const commands = {
      uname: 'uname -a',
      os: 'cat /etc/os-release 2>/dev/null || sw_vers 2>/dev/null || echo "OS info unavailable"',
      disk: 'df -h',
      memory: 'free -h 2>/dev/null || vm_stat',
      uptime: 'uptime',
    };

    const report = {};
    for (const [key, cmd] of Object.entries(commands)) {
      try {
        const result = await this.execCommand({ ...args, command: cmd });
        report[key] = { success: true, ...result };
      } catch (error) {
        report[key] = { success: false, error: error.message };
      }
    }

    return { success: true, system_info: report };
  }

  async checkHost(args) {
    try {
      const result = await this.execCommand({
        ...args,
        command: 'echo "Connection OK" && whoami && hostname',
      });
      return { success: result.exitCode === 0, response: result.stdout };
    } catch (error) {
      return { success: false, error: error.message };
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
