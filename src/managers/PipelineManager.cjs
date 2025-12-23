#!/usr/bin/env node

/**
 * 🔁 Streaming pipelines between HTTP, SFTP, and PostgreSQL.
 */

const crypto = require('crypto');
const { createReadStream } = require('fs');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const readline = require('readline');
const { redactObject } = require('../utils/redact.cjs');

class PipelineManager {
  constructor(logger, validation, apiManager, sshManager, postgresqlManager, cacheService, auditService) {
    this.logger = logger.child('pipeline');
    this.validation = validation;
    this.apiManager = apiManager;
    this.sshManager = sshManager;
    this.postgresqlManager = postgresqlManager;
    this.cacheService = cacheService;
    this.auditService = auditService;
  }

  async handleAction(args = {}) {
    const { action } = args;

    switch (action) {
      case 'run':
        return this.runPipeline(args);
      case 'describe':
        return this.describe();
      default:
        throw new Error(`Unknown pipeline action: ${action}`);
    }
  }

  describe() {
    return {
      success: true,
      flows: [
        'http_to_sftp',
        'sftp_to_http',
        'http_to_postgres',
        'sftp_to_postgres',
        'postgres_to_sftp',
        'postgres_to_http',
      ],
    };
  }

  async runPipeline(args) {
    const flow = String(args.flow || '').toLowerCase();
    if (!flow) {
      throw new Error('pipeline flow is required');
    }

    switch (flow) {
      case 'http_to_sftp':
        return this.httpToSftp(args);
      case 'sftp_to_http':
        return this.sftpToHttp(args);
      case 'http_to_postgres':
        return this.httpToPostgres(args);
      case 'sftp_to_postgres':
        return this.sftpToPostgres(args);
      case 'postgres_to_sftp':
        return this.postgresToSftp(args);
      case 'postgres_to_http':
        return this.postgresToHttp(args);
      default:
        throw new Error(`Unknown pipeline flow: ${flow}`);
    }
  }

  buildTrace(args) {
    return {
      trace_id: args.trace_id || crypto.randomUUID(),
      parent_span_id: args.span_id || args.parent_span_id,
    };
  }

  async auditStage(stage, trace, details = {}, error = null) {
    if (!this.auditService) {
      return;
    }

    const entry = {
      timestamp: new Date().toISOString(),
      status: error ? 'error' : 'ok',
      tool: 'mcp_pipeline',
      action: stage,
      trace_id: trace.trace_id,
      span_id: crypto.randomUUID(),
      parent_span_id: trace.parent_span_id,
      details: redactObject(details),
    };

    if (error) {
      entry.error = error.message;
    }

    await this.auditService.append(entry);
  }

  normalizeCache(cacheConfig, requestCache, profileCache) {
    if (!cacheConfig && !requestCache && !profileCache) {
      return { enabled: false };
    }

    const base = { enabled: true };
    const merged = {
      ...base,
      ...(profileCache || {}),
      ...(requestCache || {}),
      ...(cacheConfig || {}),
    };

    if (merged.enabled === false) {
      return { enabled: false };
    }

    return merged;
  }

  normalizeStream(response) {
    if (response?.body) {
      if (typeof response.body.pipe === 'function') {
        return response.body;
      }
      return Readable.fromWeb(response.body);
    }
    return null;
  }

  async resolveHttpProfile(httpArgs) {
    const profile = await this.apiManager.resolveProfile(httpArgs.profile_name);
    let auth = httpArgs.auth !== undefined ? httpArgs.auth : profile.auth;
    const authProvider = httpArgs.auth_provider !== undefined ? httpArgs.auth_provider : profile.authProvider;

    if (authProvider) {
      auth = await this.apiManager.resolveAuthProvider(authProvider, profile.name);
    }

    return { profile, auth };
  }

  buildExportArgs(args) {
    return {
      ...args.postgres,
      format: args.format,
      batch_size: args.batch_size,
      limit: args.limit,
      offset: args.offset,
      csv_header: args.csv_header,
      csv_delimiter: args.csv_delimiter,
      columns: args.columns,
      columns_sql: args.columns_sql,
      order_by: args.order_by,
      order_by_sql: args.order_by_sql,
      filters: args.filters,
      where_sql: args.where_sql,
      where_params: args.where_params,
      timeout_ms: args.timeout_ms,
    };
  }

  async openHttpStream(httpArgs, cacheArgs, trace) {
    if (!httpArgs || typeof httpArgs !== 'object') {
      throw new Error('http config is required');
    }

    const { profile, auth } = await this.resolveHttpProfile(httpArgs);

    const config = this.apiManager.buildRequestConfig(httpArgs, profile, auth);
    const cachePolicy = this.normalizeCache(cacheArgs, httpArgs.cache, profile.data.cache);
    const cacheKey = cachePolicy.enabled && this.cacheService
      ? (this.cacheService.normalizeKey(cachePolicy.key) || this.cacheService.buildKey({
        url: config.url,
        method: config.method,
        headers: config.headers,
        body: httpArgs.body ?? httpArgs.data ?? httpArgs.form ?? httpArgs.body_base64,
      }))
      : null;

    if (cachePolicy.enabled && this.cacheService && cacheKey) {
      const cached = await this.cacheService.getFile(cacheKey, cachePolicy.ttl_ms);
      if (cached) {
        await this.auditStage('http_cache_hit', trace, { url: config.url, cache_key: cacheKey });
        return {
          stream: createReadStream(cached.file_path),
          cache: { hit: true, key: cacheKey },
          response: { url: config.url, method: config.method },
        };
      }
    }

    const fetched = await this.apiManager.fetchWithRetry(httpArgs, profile, auth);
    const response = fetched.response;

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`HTTP source failed (${response.status}): ${text}`);
    }

    const stream = this.normalizeStream(response);
    if (!stream) {
      const buffer = Buffer.from(await response.arrayBuffer());
      return {
        stream: Readable.from(buffer),
        cache: { hit: false, key: cacheKey },
        response: { url: config.url, method: config.method, status: response.status },
      };
    }

    if (cachePolicy.enabled && this.cacheService && cacheKey) {
      const writer = await this.cacheService.createFileWriter(cacheKey, {
        ttl_ms: cachePolicy.ttl_ms,
        meta: { url: config.url, method: config.method },
      });

      try {
        await pipeline(stream, writer.stream);
        await writer.finalize();
      } catch (error) {
        await writer.abort();
        throw error;
      }

      await this.auditStage('http_cache_store', trace, { url: config.url, cache_key: cacheKey });

      return {
        stream: createReadStream(this.cacheService.dataPath(cacheKey)),
        cache: { hit: false, key: cacheKey },
        response: { url: config.url, method: config.method, status: response.status },
      };
    }

    return {
      stream,
      cache: cachePolicy.enabled ? { hit: false, key: cacheKey } : undefined,
      response: { url: config.url, method: config.method, status: response.status },
    };
  }

  async uploadStreamToSftp(stream, sftpArgs) {
    const remotePath = this.validation.ensureString(sftpArgs.remote_path, 'remote_path');
    const overwrite = sftpArgs.overwrite === true;
    const mkdirs = sftpArgs.mkdirs === true;

    await this.sshManager.withSftp(sftpArgs, async (sftp) => {
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

      if (mkdirs) {
        await this.sshManager.ensureRemoteDir(sftp, remotePath);
      }

      const writeStream = sftp.createWriteStream(remotePath);
      await pipeline(stream, writeStream);
    });

    return { remote_path: remotePath };
  }

  async httpToSftp(args) {
    const trace = this.buildTrace(args);
    const { stream, cache, response } = await this.openHttpStream(args.http, args.cache, trace);

    await this.auditStage('http_fetch', trace, { url: response.url, method: response.method, cache });
    const result = await this.uploadStreamToSftp(stream, args.sftp || {});
    await this.auditStage('sftp_upload', trace, { remote_path: result.remote_path });

    return {
      success: true,
      flow: 'http_to_sftp',
      http: response,
      sftp: result,
      cache,
    };
  }

  async sftpToHttp(args) {
    const trace = this.buildTrace(args);
    const httpArgs = args.http || {};
    const sftpArgs = args.sftp || {};

    const { profile, auth } = await this.resolveHttpProfile(httpArgs);

    const baseConfig = this.apiManager.buildRequestConfig(httpArgs, profile, auth, {
      body: undefined,
    });

    const method = baseConfig.method || 'PUT';
    const policy = this.apiManager.normalizeRetryPolicy(httpArgs.retry, profile.retry, method);

    let attempt = 0;
    let lastError = null;
    let lastStatus = null;

    const remotePath = this.validation.ensureString(sftpArgs.remote_path, 'remote_path');

    while (attempt < policy.max_attempts) {
      attempt += 1;
      try {
        const response = await this.sshManager.withSftp(sftpArgs, async (sftp) => {
          const stream = sftp.createReadStream(remotePath);
          const controller = new AbortController();
          const timeout = baseConfig.timeoutMs
            ? setTimeout(() => controller.abort(), baseConfig.timeoutMs)
            : null;

          try {
            const result = await this.apiManager.fetch(baseConfig.url, {
              method,
              headers: baseConfig.headers,
              body: stream,
              signal: controller.signal,
              redirect: baseConfig.redirect,
              duplex: 'half',
            });
            return result;
          } finally {
            if (timeout) {
              clearTimeout(timeout);
            }
          }
        });

        lastStatus = response.status;
        const headers = Object.fromEntries(response.headers.entries());
        const summary = { status: response.status, headers };

        if (!this.apiManager.shouldRetryResponse(summary, policy) || attempt >= policy.max_attempts) {
          const text = await response.text().catch(() => '');
          await this.auditStage('http_upload', trace, { url: baseConfig.url, status: response.status });
          return {
            success: response.ok,
            flow: 'sftp_to_http',
            http: { url: baseConfig.url, method, status: response.status, response: text },
          };
        }

        const delay = this.apiManager.computeRetryDelay(attempt, policy, summary);
        await new Promise((resolve) => setTimeout(resolve, delay));
      } catch (error) {
        lastError = error;
        if (!policy.retry_on_network_error || attempt >= policy.max_attempts) {
          break;
        }
        const delay = this.apiManager.computeRetryDelay(attempt, policy);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    await this.auditStage('http_upload', trace, { url: baseConfig.url, status: lastStatus }, lastError || new Error('Upload failed'));
    throw lastError || new Error('Upload failed after retries');
  }

  parseCsvLine(line, delimiter) {
    const output = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];
      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = !inQuotes;
        }
        continue;
      }

      if (char === delimiter && !inQuotes) {
        output.push(current);
        current = '';
        continue;
      }

      current += char;
    }

    output.push(current);
    return output;
  }

  async ingestStream(stream, config) {
    const format = String(config.format || 'jsonl').toLowerCase();
    if (!['jsonl', 'csv'].includes(format)) {
      throw new Error('format must be jsonl or csv');
    }

    const batchSize = Number(config.batch_size || 500);
    const maxRows = Number.isFinite(config.max_rows) ? config.max_rows : null;

    let rows = [];
    let inserted = 0;
    let columns = Array.isArray(config.columns) ? config.columns : null;

    const useHeader = config.csv_header !== undefined
      ? config.csv_header === true
      : !columns;

    const delimiter = config.csv_delimiter ? String(config.csv_delimiter) : ',';

    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (maxRows !== null && inserted + rows.length >= maxRows) {
        break;
      }

      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      if (format === 'jsonl') {
        const parsed = JSON.parse(trimmed);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('jsonl line must be an object');
        }
        rows.push(parsed);
      } else {
        const values = this.parseCsvLine(trimmed, delimiter);
        if (useHeader && !columns) {
          columns = values.map((entry) => entry.trim());
          continue;
        }
        if (!columns) {
          throw new Error('csv columns are required');
        }
        const row = {};
        columns.forEach((col, index) => {
          row[col] = values[index] ?? null;
        });
        rows.push(row);
      }

      if (rows.length >= batchSize) {
        const result = await this.postgresqlManager.insertBulk({
          ...config,
          rows,
          columns,
        });
        inserted += result.inserted || rows.length;
        rows = [];
      }
    }

    if (rows.length > 0) {
      const result = await this.postgresqlManager.insertBulk({
        ...config,
        rows,
        columns,
      });
      inserted += result.inserted || rows.length;
    }

    return { inserted };
  }

  async httpToPostgres(args) {
    const trace = this.buildTrace(args);
    const { stream, cache, response } = await this.openHttpStream(args.http, args.cache, trace);

    await this.auditStage('http_fetch', trace, { url: response.url, method: response.method, cache });
    const ingest = await this.ingestStream(stream, {
      ...args.postgres,
      format: args.format,
      batch_size: args.batch_size,
      max_rows: args.max_rows,
      csv_header: args.csv_header,
      csv_delimiter: args.csv_delimiter,
    });
    await this.auditStage('postgres_insert', trace, { inserted: ingest.inserted, table: args.postgres?.table });

    return {
      success: true,
      flow: 'http_to_postgres',
      http: response,
      postgres: { inserted: ingest.inserted },
      cache,
    };
  }

  async sftpToPostgres(args) {
    const trace = this.buildTrace(args);
    const sftpArgs = args.sftp || {};

    let ingest = { inserted: 0 };
    await this.sshManager.withSftp(sftpArgs, async (sftp) => {
      const remotePath = this.validation.ensureString(sftpArgs.remote_path, 'remote_path');
      const stream = sftp.createReadStream(remotePath);
      await this.auditStage('sftp_download', trace, { remote_path: remotePath });
      ingest = await this.ingestStream(stream, {
        ...args.postgres,
        format: args.format,
        batch_size: args.batch_size,
        max_rows: args.max_rows,
        csv_header: args.csv_header,
        csv_delimiter: args.csv_delimiter,
      });
    });

    await this.auditStage('postgres_insert', trace, { inserted: ingest.inserted, table: args.postgres?.table });

    return {
      success: true,
      flow: 'sftp_to_postgres',
      sftp: { remote_path: sftpArgs.remote_path },
      postgres: { inserted: ingest.inserted },
    };
  }

  async postgresToSftp(args) {
    const trace = this.buildTrace(args);
    const exportArgs = this.buildExportArgs(args);
    const { stream, completion } = this.postgresqlManager.exportStream(exportArgs);

    await this.auditStage('postgres_export', trace, {
      table: exportArgs.table,
      schema: exportArgs.schema,
      format: exportArgs.format,
    });

    const uploadPromise = this.uploadStreamToSftp(stream, args.sftp || {});

    try {
      const [sftpResult, exportResult] = await Promise.all([uploadPromise, completion]);
      await this.auditStage('sftp_upload', trace, { remote_path: sftpResult.remote_path });

      return {
        success: true,
        flow: 'postgres_to_sftp',
        postgres: {
          rows_written: exportResult.rows_written,
          format: exportResult.format,
          table: exportResult.table,
          schema: exportResult.schema,
          duration_ms: exportResult.duration_ms,
        },
        sftp: sftpResult,
      };
    } catch (error) {
      stream.destroy(error);
      await completion.catch(() => null);
      await this.auditStage('sftp_upload', trace, { remote_path: args.sftp?.remote_path }, error);
      throw error;
    }
  }

  async postgresToHttp(args) {
    const trace = this.buildTrace(args);
    const httpArgs = { ...(args.http || {}) };
    const exportArgs = this.buildExportArgs(args);
    const format = String(exportArgs.format || 'csv').toLowerCase();

    httpArgs.method = httpArgs.method || 'POST';
    const headers = this.validation.ensureHeaders(httpArgs.headers);
    if (!Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = format === 'jsonl' ? 'application/jsonl' : 'text/csv';
    }
    httpArgs.headers = headers;

    const { profile, auth } = await this.resolveHttpProfile(httpArgs);
    const { stream, completion } = this.postgresqlManager.exportStream(exportArgs);

    await this.auditStage('postgres_export', trace, {
      table: exportArgs.table,
      schema: exportArgs.schema,
      format,
    });

    let fetched;
    try {
      fetched = await this.apiManager.fetchWithRetry(httpArgs, profile, auth, {
        body: stream,
        duplex: 'half',
      });
    } catch (error) {
      stream.destroy(error);
      await completion.catch(() => null);
      await this.auditStage('http_upload', trace, { url: httpArgs.url }, error);
      throw error;
    }

    const exportResult = await completion;
    const response = fetched.response;
    const headersSnapshot = Object.fromEntries(response.headers.entries());
    const responseText = await response.text().catch(() => '');

    await this.auditStage('http_upload', trace, { url: fetched.config?.url ?? httpArgs.url, status: response.status });

    return {
      success: response.ok,
      flow: 'postgres_to_http',
      postgres: {
        rows_written: exportResult.rows_written,
        format: exportResult.format,
        table: exportResult.table,
        schema: exportResult.schema,
        duration_ms: exportResult.duration_ms,
      },
      http: {
        url: fetched.config?.url ?? httpArgs.url,
        method: httpArgs.method,
        status: response.status,
        headers: headersSnapshot,
        response: responseText,
        attempts: fetched.attempts,
        retries: fetched.retries,
      },
    };
  }

  getStats() {
    return {};
  }

  async cleanup() {
    return;
  }
}

module.exports = PipelineManager;
