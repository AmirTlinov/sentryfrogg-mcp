#!/usr/bin/env node
// @ts-nocheck

/**
 * 🔁 Streaming pipelines between HTTP, SFTP, and PostgreSQL.
 */

const crypto = require('crypto');
const { createReadStream } = require('fs');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const readline = require('readline');
const { redactObject } = require('../utils/redact');
const { isTruthy } = require('../utils/featureFlags');
const { unknownActionError } = require('../utils/toolErrors');
const ToolError = require('../errors/ToolError');
const {
  resolveContextRepoRoot,
  buildToolCallFileRef,
  createArtifactWriteStream,
} = require('../utils/artifacts');

const DEFAULT_MAX_CAPTURE_BYTES = 256 * 1024;
const PIPELINE_ACTIONS = ['run', 'describe', 'deploy_smoke'];
const PIPELINE_FLOWS = [
  'http_to_sftp',
  'sftp_to_http',
  'http_to_postgres',
  'sftp_to_postgres',
  'postgres_to_sftp',
  'postgres_to_http',
];

function readPositiveInt(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return Math.floor(numeric);
}

function resolveStreamToArtifactMode() {
  const raw = process.env.SENTRYFROGG_PIPELINE_STREAM_TO_ARTIFACT
    || process.env.SF_PIPELINE_STREAM_TO_ARTIFACT
    || process.env.SENTRYFROGG_STREAM_TO_ARTIFACT
    || process.env.SF_STREAM_TO_ARTIFACT;
  if (raw === undefined || raw === null) {
    return null;
  }
  const normalized = String(raw).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized === 'full') {
    return 'full';
  }
  if (normalized === 'capped') {
    return 'capped';
  }
  return isTruthy(normalized) ? 'capped' : null;
}

function resolveMaxCaptureBytes() {
  const fromEnv = readPositiveInt(
    process.env.SENTRYFROGG_PIPELINE_MAX_CAPTURE_BYTES
    || process.env.SF_PIPELINE_MAX_CAPTURE_BYTES
    || process.env.SENTRYFROGG_MAX_CAPTURE_BYTES
    || process.env.SF_MAX_CAPTURE_BYTES
  );
  return fromEnv ?? DEFAULT_MAX_CAPTURE_BYTES;
}

class ArtifactCaptureTransform extends Transform {
  constructor(writer, { limitBytes, onDone }) {
    super();
    this.writer = writer;
    this.limitBytes = limitBytes;
    this.totalBytes = 0;
    this.writtenBytes = 0;
    this.truncated = false;
    this.done = false;
    this.onDone = typeof onDone === 'function' ? onDone : () => null;
  }

  _transform(chunk, encoding, callback) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk ?? '', encoding);
    this.totalBytes += buf.length;

    if (this.writer && this.writtenBytes < this.limitBytes) {
      const remaining = this.limitBytes - this.writtenBytes;
      const slice = buf.length <= remaining ? buf : buf.subarray(0, remaining);
      if (slice.length < buf.length) {
        this.truncated = true;
      }

      try {
        const ok = this.writer.stream.write(slice);
        this.writtenBytes += slice.length;
        this.push(buf);
        if (!ok) {
          this.writer.stream.once('drain', () => callback());
          return;
        }
        callback();
        return;
      } catch (error) {
        void this.writer.abort().catch(() => null);
        this.writer = null;
        this.truncated = true;
      }
    } else if (this.limitBytes !== Number.POSITIVE_INFINITY) {
      this.truncated = true;
    }

    this.push(buf);
    callback();
  }

  _final(callback) {
    if (this.done) {
      callback();
      return;
    }
    this.done = true;

    if (!this.writer || this.writtenBytes === 0) {
      const cleanup = this.writer ? this.writer.abort().catch(() => null) : Promise.resolve();
      cleanup
        .then(() => {
          this.onDone(null);
          callback();
        })
        .catch(() => {
          this.onDone(null);
          callback();
        });
      return;
    }

    this.writer.finalize()
      .then((artifact) => {
        this.onDone({
          uri: artifact.uri,
          rel: artifact.rel,
          bytes: artifact.bytes,
          captured_bytes: this.writtenBytes,
          total_bytes: this.totalBytes,
          truncated: this.truncated,
        });
        callback();
      })
      .catch(() => {
        this.writer.abort().catch(() => null)
          .finally(() => {
            this.onDone(null);
            callback();
          });
      });
  }

  _destroy(error, callback) {
    if (this.done) {
      callback(error);
      return;
    }
    this.done = true;
    if (this.writer) {
      this.writer.abort().catch(() => null)
        .finally(() => {
          this.onDone(null);
          callback(error);
        });
      return;
    }
    this.onDone(null);
    callback(error);
  }
}

class PipelineManager {
  constructor(logger, validation, apiManager, sshManager, postgresqlManager, cacheService, auditService, projectResolver) {
    this.logger = logger.child('pipeline');
    this.validation = validation;
    this.apiManager = apiManager;
    this.sshManager = sshManager;
    this.postgresqlManager = postgresqlManager;
    this.cacheService = cacheService;
    this.auditService = auditService;
    this.projectResolver = projectResolver;
  }

  async handleAction(args = {}) {
    const { action } = args;

    switch (action) {
      case 'run':
        return this.runPipeline(args);
      case 'describe':
        return this.describe();
      case 'deploy_smoke':
        return this.deploySmoke(args);
      default:
        throw unknownActionError({ tool: 'pipeline', action, knownActions: PIPELINE_ACTIONS });
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

  async deploySmoke(args = {}) {
    const startedAt = Date.now();
    const trace = this.buildTrace(args);

    const localPath = this.validation.ensureString(args.local_path, 'local_path');
    const remotePath = this.validation.ensureString(args.remote_path, 'remote_path');
    const url = this.validation.ensureString(args.url, 'url');

    const settleMs = Math.min(readPositiveInt(args.settle_ms) ?? 0, 120000);
    const maxAttempts = Math.min(readPositiveInt(args.smoke_attempts) ?? 5, 20);
    const delayMs = Math.min(readPositiveInt(args.smoke_delay_ms) ?? 1000, 60000);
    const smokeTimeoutMs = Math.min(readPositiveInt(args.smoke_timeout_ms) ?? 10000, 120000);

    await this.auditStage('deploy_smoke.deploy', trace, { local_path: localPath, remote_path: remotePath });

    const deploy = await this.sshManager.deployFile({
      ...args,
      action: 'deploy_file',
      local_path: localPath,
      remote_path: remotePath,
      restart: args.restart,
      restart_command: args.restart_command,
    });

    if (!deploy || deploy.success !== true) {
      await this.auditStage('deploy_smoke.failed', trace, { stage: 'deploy' });
      return {
        success: false,
        code: 'DEPLOY_FAILED',
        deploy,
        smoke: null,
        duration_ms: Date.now() - startedAt,
      };
    }

    if (settleMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, settleMs));
    }

    await this.auditStage('deploy_smoke.smoke', trace, { url, attempts: maxAttempts });

    let last = null;
    let okAt = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      last = await this.apiManager.smokeHttp({
        ...args,
        action: 'smoke_http',
        url,
        timeout_ms: smokeTimeoutMs,
      });

      const ok = Boolean(last?.success && last?.ok);
      if (ok) {
        okAt = attempt;
        break;
      }

      if (attempt < maxAttempts && delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    const smokeOk = Boolean(last?.success && last?.ok);
    const success = Boolean(deploy?.success && smokeOk);
    const summary = smokeOk
      ? 'deploy ok; smoke ok'
      : 'deploy ok; smoke failed';

    const nextActions = smokeOk
      ? []
      : [
        { tool: 'api', action: 'smoke_http', args: { url, expect_code: args.expect_code ?? 200, follow_redirects: args.follow_redirects !== false, insecure_ok: args.insecure_ok !== false } },
      ];

    return {
      success,
      summary,
      deploy,
      smoke: last,
      attempts: { max_attempts: maxAttempts, ok_at: okAt, delay_ms: delayMs, timeout_ms: smokeTimeoutMs },
      next_actions: nextActions,
      duration_ms: Date.now() - startedAt,
    };
  }

  async runPipeline(args) {
    const flow = String(args.flow || '').toLowerCase();
    if (!flow) {
      throw ToolError.invalidParams({
        field: 'flow',
        message: 'pipeline flow is required',
        hint: `Use one of: ${PIPELINE_FLOWS.join(', ')}`,
      });
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
        throw ToolError.invalidParams({
          field: 'flow',
          message: `Unknown pipeline flow: ${flow}`,
          hint: `Use one of: ${PIPELINE_FLOWS.join(', ')}`,
        });
    }
  }

  buildTrace(args) {
    return {
      trace_id: args.trace_id || crypto.randomUUID(),
      parent_span_id: args.span_id || args.parent_span_id,
    };
  }

  mergeProjectContext(childArgs, rootArgs) {
    if (!childArgs || typeof childArgs !== 'object') {
      return childArgs;
    }

    const merged = { ...childArgs };

    if (merged.project === undefined && merged.project_name === undefined) {
      const rootProject = rootArgs?.project ?? rootArgs?.project_name;
      if (rootProject !== undefined) {
        merged.project = rootProject;
      }
    }

    const hasTarget = merged.target !== undefined || merged.project_target !== undefined || merged.environment !== undefined;
    if (!hasTarget) {
      const rootTarget = rootArgs?.target ?? rootArgs?.project_target ?? rootArgs?.environment;
      if (rootTarget !== undefined) {
        merged.target = rootTarget;
      }
    }

    if (merged.vault_profile_name === undefined && merged.vault_profile === undefined) {
      const rootVaultProfileName = rootArgs?.vault_profile_name;
      const rootVaultProfile = rootArgs?.vault_profile;
      if (rootVaultProfileName !== undefined) {
        merged.vault_profile_name = rootVaultProfileName;
      } else if (rootVaultProfile !== undefined) {
        merged.vault_profile = rootVaultProfile;
      }
    }

    return merged;
  }

  async hydrateProjectDefaults(args) {
    if (!this.projectResolver) {
      return args;
    }

    const needsSftpProfile = !!(args.sftp && typeof args.sftp === 'object' && !args.sftp.profile_name && !args.sftp.connection);
    const needsPostgresProfile = !!(args.postgres && typeof args.postgres === 'object'
      && !args.postgres.profile_name && !args.postgres.connection && !args.postgres.connection_url);
    const explicitlyScoped = args.project !== undefined || args.project_name !== undefined
      || args.target !== undefined || args.project_target !== undefined || args.environment !== undefined;

    if (!explicitlyScoped && !needsSftpProfile && !needsPostgresProfile) {
      return args;
    }

    const context = await this.projectResolver.resolveContext(args);
    const target = context?.target || {};

    const hydrated = { ...args };

    if (args.http && typeof args.http === 'object') {
      const httpArgs = this.mergeProjectContext(args.http, args);
      if (!httpArgs.profile_name && target.api_profile) {
        httpArgs.profile_name = String(target.api_profile);
      }
      hydrated.http = httpArgs;
    }

    if (args.postgres && typeof args.postgres === 'object') {
      const postgresArgs = this.mergeProjectContext(args.postgres, args);
      if (!postgresArgs.profile_name && target.postgres_profile) {
        postgresArgs.profile_name = String(target.postgres_profile);
      }
      hydrated.postgres = postgresArgs;
    }

    if (args.sftp && typeof args.sftp === 'object') {
      const sftpArgs = this.mergeProjectContext(args.sftp, args);
      if (!sftpArgs.profile_name && target.ssh_profile) {
        sftpArgs.profile_name = String(target.ssh_profile);
      }
      hydrated.sftp = sftpArgs;
    }

    return hydrated;
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
    const profile = await this.apiManager.resolveProfile(httpArgs.profile_name, httpArgs);
    let auth = httpArgs.auth !== undefined ? httpArgs.auth : profile.auth;
    const authProvider = httpArgs.auth_provider !== undefined ? httpArgs.auth_provider : profile.authProvider;

    if (authProvider) {
      auth = await this.apiManager.resolveAuthProvider(authProvider, profile.name, httpArgs);
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

  async captureStreamToArtifact(stream, trace, { prefix = 'stream' } = {}) {
    const mode = resolveStreamToArtifactMode();
    const contextRoot = mode ? resolveContextRepoRoot() : null;
    if (!mode || !contextRoot || !stream) {
      return { stream, artifact: null };
    }

    const limitBytes = mode === 'full' ? Number.POSITIVE_INFINITY : resolveMaxCaptureBytes();
    const traceId = trace?.trace_id || 'run';
    const spanId = trace?.parent_span_id || crypto.randomUUID();
    const filename = `${prefix}-${crypto.randomUUID()}.bin`;
    const ref = buildToolCallFileRef({ traceId, spanId, filename });

    let writer;
    try {
      writer = await createArtifactWriteStream(contextRoot, ref);
    } catch (error) {
      this.logger.warn('Failed to initialize pipeline artifact stream', { error: error.message });
      return { stream, artifact: null };
    }

    let resolveDone;
    const done = new Promise((resolve) => {
      resolveDone = resolve;
    });

    const tap = new ArtifactCaptureTransform(writer, { limitBytes, onDone: resolveDone });
    void pipeline(stream, tap).catch(() => null);

    return {
      stream: tap,
      artifact: {
        uri: ref.uri,
        rel: ref.rel,
        done,
      },
    };
  }

  async openHttpStream(httpArgs, cacheArgs, trace) {
    if (!httpArgs || typeof httpArgs !== 'object') {
      throw ToolError.invalidParams({ field: 'http', message: 'http config is required' });
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
        const captured = await this.captureStreamToArtifact(
          createReadStream(cached.file_path),
          trace,
          { prefix: 'http-body' }
        );
        return {
          stream: captured.stream,
          artifact: captured.artifact,
          cache: { hit: true, key: cacheKey },
          response: { url: config.url, method: config.method },
        };
      }
    }

    const fetched = await this.apiManager.fetchWithRetry(httpArgs, profile, auth);
    const response = fetched.response;

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const redacted = redactObject(String(text || ''), { maxString: 16 * 1024 });
      if (response.status === 401 || response.status === 403) {
        throw ToolError.denied({
          code: 'HTTP_DENIED',
          message: `HTTP source failed (${response.status})`,
          hint: 'Check auth / auth_provider configuration for the API profile.',
          details: { status: response.status, body: redacted },
        });
      }
      if (response.status === 404) {
        throw ToolError.notFound({
          code: 'HTTP_NOT_FOUND',
          message: `HTTP source failed (${response.status})`,
          hint: 'Verify the URL/path is correct.',
          details: { status: response.status, body: redacted },
        });
      }
      if (response.status === 429 || response.status >= 500) {
        throw ToolError.retryable({
          code: 'HTTP_RETRYABLE',
          message: `HTTP source failed (${response.status})`,
          hint: 'Retry later or increase timeout/retries.',
          details: { status: response.status, body: redacted },
        });
      }
      throw ToolError.invalidParams({
        field: 'http',
        message: `HTTP source failed (${response.status})`,
        hint: 'Check request parameters (headers/query/body) and retry.',
        details: { status: response.status, body: redacted },
      });
    }

    const stream = this.normalizeStream(response);
    if (!stream) {
      const buffer = Buffer.from(await response.arrayBuffer());
      const captured = await this.captureStreamToArtifact(
        Readable.from(buffer),
        trace,
        { prefix: 'http-body' }
      );
      return {
        stream: captured.stream,
        artifact: captured.artifact,
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

      const captured = await this.captureStreamToArtifact(
        createReadStream(this.cacheService.dataPath(cacheKey)),
        trace,
        { prefix: 'http-body' }
      );
      return {
        stream: captured.stream,
        artifact: captured.artifact,
        cache: { hit: false, key: cacheKey },
        response: { url: config.url, method: config.method, status: response.status },
      };
    }

    const captured = await this.captureStreamToArtifact(stream, trace, { prefix: 'http-body' });

    return {
      stream: captured.stream,
      artifact: captured.artifact,
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
    const hydrated = await this.hydrateProjectDefaults(args);
    const trace = this.buildTrace(hydrated);
    const { stream, cache, response, artifact } = await this.openHttpStream(hydrated.http, hydrated.cache, trace);

    await this.auditStage('http_fetch', trace, { url: response.url, method: response.method, cache });
    const result = await this.uploadStreamToSftp(stream, hydrated.sftp || {});
    await this.auditStage('sftp_upload', trace, { remote_path: result.remote_path });

    const bodyArtifact = artifact?.done ? await artifact.done : null;
    const httpResponse = bodyArtifact
      ? {
        ...response,
        body_ref: { uri: bodyArtifact.uri, rel: bodyArtifact.rel, bytes: bodyArtifact.bytes },
        body_ref_truncated: bodyArtifact.truncated,
      }
      : response;

    return {
      success: true,
      flow: 'http_to_sftp',
      http: httpResponse,
      sftp: result,
      cache,
    };
  }

  async sftpToHttp(args) {
    const hydrated = await this.hydrateProjectDefaults(args);
    const trace = this.buildTrace(hydrated);
    const httpArgs = hydrated.http || {};
    const sftpArgs = hydrated.sftp || {};

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

    const failure = lastError;
    const error = ToolError.isToolError(failure)
      ? failure
      : ToolError.retryable({
        code: 'HTTP_UPLOAD_FAILED',
        message: 'Upload failed after retries',
        hint: failure?.message ? `Last error: ${failure.message}` : undefined,
      });
    await this.auditStage('http_upload', trace, { url: baseConfig.url, status: lastStatus }, error);
    throw error;
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
      throw ToolError.invalidParams({ field: 'format', message: 'format must be jsonl or csv' });
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
          throw ToolError.invalidParams({ field: 'format', message: 'jsonl line must be an object' });
        }
        rows.push(parsed);
      } else {
        const values = this.parseCsvLine(trimmed, delimiter);
        if (useHeader && !columns) {
          columns = values.map((entry) => entry.trim());
          continue;
        }
        if (!columns) {
          throw ToolError.invalidParams({ field: 'columns', message: 'csv columns are required' });
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
    const hydrated = await this.hydrateProjectDefaults(args);
    const trace = this.buildTrace(hydrated);
    const { stream, cache, response, artifact } = await this.openHttpStream(hydrated.http, hydrated.cache, trace);

    await this.auditStage('http_fetch', trace, { url: response.url, method: response.method, cache });
    const ingest = await this.ingestStream(stream, {
      ...hydrated.postgres,
      format: hydrated.format,
      batch_size: hydrated.batch_size,
      max_rows: hydrated.max_rows,
      csv_header: hydrated.csv_header,
      csv_delimiter: hydrated.csv_delimiter,
    });
    await this.auditStage('postgres_insert', trace, { inserted: ingest.inserted, table: hydrated.postgres?.table });

    const bodyArtifact = artifact?.done ? await artifact.done : null;
    const httpResponse = bodyArtifact
      ? {
        ...response,
        body_ref: { uri: bodyArtifact.uri, rel: bodyArtifact.rel, bytes: bodyArtifact.bytes },
        body_ref_truncated: bodyArtifact.truncated,
      }
      : response;

    return {
      success: true,
      flow: 'http_to_postgres',
      http: httpResponse,
      postgres: { inserted: ingest.inserted },
      cache,
    };
  }

  async sftpToPostgres(args) {
    const hydrated = await this.hydrateProjectDefaults(args);
    const trace = this.buildTrace(hydrated);
    const sftpArgs = hydrated.sftp || {};

    let ingest = { inserted: 0 };
    await this.sshManager.withSftp(sftpArgs, async (sftp) => {
      const remotePath = this.validation.ensureString(sftpArgs.remote_path, 'remote_path');
      const stream = sftp.createReadStream(remotePath);
      await this.auditStage('sftp_download', trace, { remote_path: remotePath });
      ingest = await this.ingestStream(stream, {
        ...hydrated.postgres,
        format: hydrated.format,
        batch_size: hydrated.batch_size,
        max_rows: hydrated.max_rows,
        csv_header: hydrated.csv_header,
        csv_delimiter: hydrated.csv_delimiter,
      });
    });

    await this.auditStage('postgres_insert', trace, { inserted: ingest.inserted, table: hydrated.postgres?.table });

    return {
      success: true,
      flow: 'sftp_to_postgres',
      sftp: { remote_path: sftpArgs.remote_path },
      postgres: { inserted: ingest.inserted },
    };
  }

  async postgresToSftp(args) {
    const hydrated = await this.hydrateProjectDefaults(args);
    const trace = this.buildTrace(hydrated);
    const exportArgs = this.buildExportArgs(hydrated);
    const { stream, completion } = this.postgresqlManager.exportStream(exportArgs);

    await this.auditStage('postgres_export', trace, {
      table: exportArgs.table,
      schema: exportArgs.schema,
      format: exportArgs.format,
    });

    const uploadPromise = this.uploadStreamToSftp(stream, hydrated.sftp || {});

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
      await this.auditStage('sftp_upload', trace, { remote_path: hydrated.sftp?.remote_path }, error);
      throw error;
    }
  }

  async postgresToHttp(args) {
    const hydrated = await this.hydrateProjectDefaults(args);
    const trace = this.buildTrace(hydrated);
    const httpArgs = { ...(hydrated.http || {}) };
    const exportArgs = this.buildExportArgs(hydrated);
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
