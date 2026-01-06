#!/usr/bin/env node

/**
 * 📦 Repo Manager (safe-by-default)
 *
 * Contract:
 * - sandboxed to repo_root
 * - no shell execution
 * - allowlisted commands only
 * - write actions require apply=true
 */

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  buildToolCallFileRef,
  resolveContextRepoRoot,
  writeBinaryArtifact,
} = require('../utils/artifacts.cjs');
const { resolveSandboxPath } = require('../utils/sandbox.cjs');

const DEFAULT_ALLOWED_COMMANDS = ['git'];
const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  'status',
  'diff',
  'log',
  'show',
  'rev-parse',
  'ls-files',
  'cat-file',
  'grep',
  'describe',
]);

const READ_ONLY_EXEC_SUBCOMMANDS = {
  kubectl: new Set(['api-resources', 'api-versions', 'describe', 'diff', 'explain', 'get', 'kustomize', 'version']),
  helm: new Set(['template', 'lint', 'show']),
  kustomize: new Set(['build']),
};

const READ_ONLY_EXEC_SUBSUBCOMMANDS = {
  kubectl: {
    rollout: new Set(['history', 'status']),
  },
};

const KUBECTL_FLAGS_WITH_VALUE = new Set([
  '-n',
  '--namespace',
  '--context',
  '--cluster',
  '--user',
  '--kubeconfig',
  '--server',
  '--request-timeout',
]);

function findKubectlToken(argv, startIndex) {
  for (let idx = startIndex; idx < argv.length; idx += 1) {
    const token = argv[idx];
    if (typeof token !== 'string' || !token.trim()) {
      continue;
    }
    if (token === '--') {
      const next = argv[idx + 1];
      if (typeof next === 'string' && next.trim()) {
        return { token: next, index: idx + 1 };
      }
      return null;
    }
    if (token.startsWith('-')) {
      if (token.startsWith('--') && token.includes('=')) {
        continue;
      }
      if (KUBECTL_FLAGS_WITH_VALUE.has(token)) {
        idx += 1;
      }
      continue;
    }
    return { token, index: idx };
  }
  return null;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_CAPTURE_BYTES = 256 * 1024;
const DEFAULT_MAX_INLINE_BYTES = 16 * 1024;

const DEFAULT_MAX_RENDER_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_RENDER_STDERR_BYTES = 128 * 1024;

const DEFAULT_MAX_PATCH_BYTES = 2 * 1024 * 1024;

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

function splitAllowlist(value) {
  if (!value || typeof value !== 'string') {
    return null;
  }
  const tokens = value
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return tokens.length > 0 ? tokens : null;
}

function stripYamlComment(value) {
  if (typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith('#')) {
    return '';
  }
  const match = trimmed.match(/^(.*?)\s+#/);
  return match ? match[1].trim() : trimmed;
}

function stripYamlQuotes(value) {
  if (typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function parseContainerImageRef(raw) {
  const image = stripYamlQuotes(stripYamlComment(String(raw ?? '')));
  if (!image) {
    return null;
  }

  const atIndex = image.indexOf('@');
  const withTag = atIndex === -1 ? image : image.slice(0, atIndex);
  const digest = atIndex === -1 ? null : image.slice(atIndex + 1).trim() || null;

  const lastSlash = withTag.lastIndexOf('/');
  const lastColon = withTag.lastIndexOf(':');

  let name = withTag;
  let tag = null;
  if (lastColon > lastSlash) {
    name = withTag.slice(0, lastColon);
    tag = withTag.slice(lastColon + 1) || null;
  }

  const pinned = Boolean(digest);
  const usesLatest = !pinned && (!tag || tag === 'latest');

  return {
    image,
    name,
    tag,
    digest,
    pinned,
    uses_latest: usesLatest,
  };
}

function extractK8sImages(renderedText) {
  const text = typeof renderedText === 'string' ? renderedText : String(renderedText ?? '');
  const lines = text.split(/\r?\n/);

  const seen = new Set();
  const images = [];

  let kind = null;
  let name = null;
  let metadataIndent = null;

  const resetDoc = () => {
    kind = null;
    name = null;
    metadataIndent = null;
  };

  for (const line of lines) {
    if (line.trim() === '---') {
      resetDoc();
      continue;
    }

    const indentMatch = line.match(/^\s*/);
    const indent = indentMatch ? indentMatch[0].length : 0;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const kindMatch = trimmed.match(/^kind:\s*(\S+)/i);
    if (kindMatch && indent === 0) {
      kind = kindMatch[1];
      continue;
    }

    if (/^metadata:\s*$/i.test(trimmed)) {
      metadataIndent = indent;
      continue;
    }

    if (metadataIndent !== null) {
      if (indent <= metadataIndent) {
        metadataIndent = null;
      } else {
        const nameMatch = trimmed.match(/^name:\s*(\S+)/i);
        if (nameMatch && name === null) {
          name = stripYamlQuotes(stripYamlComment(nameMatch[1]));
        }
      }
    }

    const imageMatch = trimmed.match(/^image:\s*(.+)$/i);
    if (!imageMatch) {
      continue;
    }

    const parsed = parseContainerImageRef(imageMatch[1]);
    if (!parsed) {
      continue;
    }

    if (seen.has(parsed.image)) {
      continue;
    }
    seen.add(parsed.image);
    images.push({
      ...parsed,
      resource_kind: kind,
      resource_name: name,
    });
  }

  const unpinned = images.filter((entry) => !entry.pinned);
  const latest = images.filter((entry) => entry.uses_latest);

  return {
    images,
    summary: {
      total: images.length,
      unpinned: unpinned.length,
      latest: latest.length,
    },
    violations: {
      unpinned: unpinned.slice(0, 25).map((entry) => entry.image),
      latest: latest.slice(0, 25).map((entry) => entry.image),
      truncated: {
        unpinned: unpinned.length > 25,
        latest: latest.length > 25,
      },
    },
  };
}

class RepoManager {
  constructor(logger, security, validation, projectResolver) {
    this.logger = logger.child('repo');
    this.security = security;
    this.validation = validation;
    this.projectResolver = projectResolver;

    this.stats = {
      calls: 0,
      errors: 0,
      exec: 0,
    };
  }

  async handleAction(args = {}) {
    const action = args.action;
    this.stats.calls += 1;

    switch (action) {
      case 'exec':
        return this.exec(args);
      case 'repo_info':
        return this.repoInfo(args);
      case 'assert_clean':
        return this.assertClean(args);
      case 'git_diff':
        return this.gitDiff(args);
      case 'render':
        return this.render(args);
      case 'apply_patch':
        return this.applyPatch(args);
      case 'git_commit':
        return this.gitCommit(args);
      case 'git_revert':
        return this.gitRevert(args);
      case 'git_push':
        return this.gitPush(args);
      default:
        this.stats.errors += 1;
        throw new Error(`Unknown repo action: ${action}`);
    }
  }

  async assertClean(args) {
    const repoRootRaw = await this.resolveRepoRoot(args);
    const repoRoot = await resolveSandboxPath(repoRootRaw, null);
    const gitRoot = await this.resolveGitRoot(repoRoot);

    const { maxCaptureBytes, timeoutMs } = this.resolveExecBudgets();
    const status = await this.runGit({
      cwd: gitRoot,
      argv: ['status', '--porcelain'],
      timeoutMs,
      maxCaptureBytes: Math.min(maxCaptureBytes, 64 * 1024),
    });

    if (status.exit_code !== 0) {
      throw new Error(status.stderr_buffer.toString('utf8').trim() || 'git status failed');
    }

    const output = status.stdout_buffer.toString('utf8').trimEnd();
    if (output.trim().length > 0) {
      const preview = output.split(/\r?\n/).slice(0, 20).join('\n');
      throw new Error(`Repository is dirty (uncommitted changes). Refusing to continue.\n\n${preview}`);
    }

    return { success: true, repo_root: gitRoot, clean: true };
  }

  resolveAllowedCommands() {
    const raw = process.env.SENTRYFROGG_REPO_ALLOWED_COMMANDS || process.env.SF_REPO_ALLOWED_COMMANDS;
    return splitAllowlist(raw) || DEFAULT_ALLOWED_COMMANDS;
  }

  resolveExecBudgets() {
    const captureEnv = process.env.SENTRYFROGG_REPO_EXEC_MAX_CAPTURE_BYTES || process.env.SF_REPO_EXEC_MAX_CAPTURE_BYTES;
    const inlineEnv = process.env.SENTRYFROGG_REPO_EXEC_MAX_INLINE_BYTES || process.env.SF_REPO_EXEC_MAX_INLINE_BYTES;
    const timeoutEnv = process.env.SENTRYFROGG_REPO_EXEC_TIMEOUT_MS || process.env.SF_REPO_EXEC_TIMEOUT_MS;

    const maxCaptureBytes = readPositiveInt(captureEnv) ?? DEFAULT_MAX_CAPTURE_BYTES;
    const maxInlineBytes = readPositiveInt(inlineEnv) ?? DEFAULT_MAX_INLINE_BYTES;
    const timeoutMs = readPositiveInt(timeoutEnv) ?? DEFAULT_TIMEOUT_MS;

    return { maxCaptureBytes, maxInlineBytes, timeoutMs };
  }

  resolvePatchBudgetBytes() {
    const patchEnv = process.env.SENTRYFROGG_REPO_MAX_PATCH_BYTES || process.env.SF_REPO_MAX_PATCH_BYTES;
    return readPositiveInt(patchEnv) ?? DEFAULT_MAX_PATCH_BYTES;
  }

  resolveRenderBudgets() {
    const bytesEnv = process.env.SENTRYFROGG_REPO_RENDER_MAX_BYTES || process.env.SF_REPO_RENDER_MAX_BYTES;
    const timeoutEnv = process.env.SENTRYFROGG_REPO_RENDER_TIMEOUT_MS || process.env.SF_REPO_RENDER_TIMEOUT_MS;

    const maxBytes = readPositiveInt(bytesEnv) ?? DEFAULT_MAX_RENDER_BYTES;
    const timeoutMs = readPositiveInt(timeoutEnv) ?? this.resolveExecBudgets().timeoutMs;

    return {
      maxBytes,
      maxStderrBytes: DEFAULT_MAX_RENDER_STDERR_BYTES,
      timeoutMs,
    };
  }

  normalizeCommand(rawCommand, allowedCommands) {
    const command = this.security.cleanCommand(rawCommand);
    if (command.includes(' ') || command.includes('\t') || command.includes('\n')) {
      throw new Error('command must be a single executable (no whitespace)');
    }
    if (command.includes('/') || command.includes('\\')) {
      throw new Error('command must not contain path separators');
    }

    if (!allowedCommands.includes(command)) {
      throw new Error(`Command not allowed: ${command}`);
    }

    return command;
  }

  normalizeArgs(argv) {
    if (argv === undefined || argv === null) {
      return [];
    }
    if (!Array.isArray(argv)) {
      throw new Error('args must be an array of strings');
    }
    return argv.map((item) => String(item));
  }

  normalizeEnv(env) {
    if (env === undefined || env === null) {
      return undefined;
    }
    if (typeof env !== 'object' || Array.isArray(env)) {
      throw new Error('env must be an object');
    }

    const blocked = new Set(['PATH', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'NODE_OPTIONS']);
    return Object.fromEntries(
      Object.entries(env).flatMap(([key, value]) => {
        if (!key || typeof key !== 'string') {
          return [];
        }
        const trimmed = key.trim();
        if (!trimmed || blocked.has(trimmed)) {
          return [];
        }
        if (value === undefined || value === null) {
          return [];
        }
        return [[trimmed, String(value)]];
      })
    );
  }

  async resolveRepoRoot(args) {
    if (args.repo_root) {
      return this.validation.ensureString(String(args.repo_root), 'repo_root', { trim: false });
    }

    if (this.projectResolver) {
      const context = await this.projectResolver.resolveContext(args).catch(() => null);
      const cwd = context?.target?.cwd;
      if (cwd) {
        return this.validation.ensureString(String(cwd), 'repo_root', { trim: false });
      }
    }

    throw new Error('repo_root is required (or resolve it via project target cwd)');
  }

  async runGit({ cwd, argv, stdin, timeoutMs, maxCaptureBytes }) {
    const child = spawn('git', ['--no-pager', ...argv], {
      cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
      },
      shell: false,
      windowsHide: true,
    });

    if (stdin !== undefined && stdin !== null) {
      child.stdin?.end(String(stdin));
    } else {
      child.stdin?.end();
    }

    let stdoutBuffers = [];
    let stderrBuffers = [];
    const stdoutState = { total: 0, captured: 0, buffers: stdoutBuffers, truncated: false };
    const stderrState = { total: 0, captured: 0, buffers: stderrBuffers, truncated: false };

    const capture = (chunk, state) => {
      const size = chunk.length;
      state.total += size;
      if (state.captured >= maxCaptureBytes) {
        state.truncated = true;
        return;
      }
      const remaining = maxCaptureBytes - state.captured;
      if (size <= remaining) {
        state.buffers.push(chunk);
        state.captured += size;
        return;
      }
      state.buffers.push(chunk.subarray(0, remaining));
      state.captured += remaining;
      state.truncated = true;
    };

    child.stdout?.on('data', (chunk) => capture(chunk, stdoutState));
    child.stderr?.on('data', (chunk) => capture(chunk, stderrState));

    let timedOut = false;
    let timeout;
    if (timeoutMs) {
      timeout = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGKILL');
        } catch (error) {
        }
      }, timeoutMs);
    }

    const finished = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, sig) => resolve({ code, sig }));
    });

    if (timeout) {
      clearTimeout(timeout);
    }

    const stdoutBuffer = stdoutState.captured
      ? Buffer.concat(stdoutBuffers, stdoutState.captured)
      : Buffer.alloc(0);
    const stderrBuffer = stderrState.captured
      ? Buffer.concat(stderrBuffers, stderrState.captured)
      : Buffer.alloc(0);

    return {
      exit_code: typeof finished.code === 'number' ? finished.code : 1,
      signal: finished.sig,
      timed_out: timedOut,
      stdout_bytes: stdoutState.total,
      stderr_bytes: stderrState.total,
      stdout_captured_bytes: stdoutState.captured,
      stderr_captured_bytes: stderrState.captured,
      stdout_truncated: stdoutState.truncated,
      stderr_truncated: stderrState.truncated,
      stdout_buffer: stdoutBuffer,
      stderr_buffer: stderrBuffer,
    };
  }

  async resolveGitRoot(repoRoot) {
    const { maxCaptureBytes, timeoutMs } = this.resolveExecBudgets();
    const result = await this.runGit({
      cwd: repoRoot,
      argv: ['rev-parse', '--show-toplevel'],
      timeoutMs,
      maxCaptureBytes: Math.min(maxCaptureBytes, 64 * 1024),
    });

    if (result.exit_code !== 0) {
      const stderr = result.stderr_buffer.toString('utf8').trim();
      throw new Error(stderr || 'Not a git repository');
    }

    const top = result.stdout_buffer.toString('utf8').trim();
    if (!top) {
      throw new Error('Unable to resolve git root');
    }

    const resolved = await resolveSandboxPath(repoRoot, top);
    if (resolved !== repoRoot) {
      throw new Error('repo_root must be the git toplevel directory');
    }

    return resolved;
  }

  async writeArtifact(filename, buffer, { traceId, spanId, truncated } = {}) {
    const contextRoot = resolveContextRepoRoot();
    if (!contextRoot || !buffer || !buffer.length) {
      return null;
    }

    const artifact = await writeBinaryArtifact(
      contextRoot,
      buildToolCallFileRef({ traceId, spanId, filename }),
      buffer
    );

    return {
      uri: artifact.uri,
      rel: artifact.rel,
      path: artifact.path,
      bytes: artifact.bytes,
      truncated: Boolean(truncated),
    };
  }

  async detectRenderType({ repoRoot, renderType, overlay, chart }) {
    if (renderType) {
      return renderType;
    }

    if (chart) {
      return 'helm';
    }

    if (overlay) {
      const candidate = await resolveSandboxPath(repoRoot, overlay, { mustExist: true });
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) {
        const markers = ['kustomization.yaml', 'kustomization.yml', 'Kustomization'];
        for (const marker of markers) {
          const exists = await fs
            .stat(path.join(candidate, marker))
            .then((entry) => entry.isFile())
            .catch(() => false);
          if (exists) {
            return 'kustomize';
          }
        }
      }
    }

    return 'plain';
  }

  async renderPlain({ repoRoot, overlayAbs, maxBytes }) {
    const stat = await fs.stat(overlayAbs);

    if (stat.isFile()) {
      if (stat.size > maxBytes) {
        throw new Error(`Plain render output exceeds max_bytes (${stat.size} > ${maxBytes})`);
      }
      const buffer = await fs.readFile(overlayAbs);
      return { buffer, sources: [path.relative(repoRoot, overlayAbs)] };
    }

    if (!stat.isDirectory()) {
      throw new Error('overlay must be a file or directory');
    }

    const entries = await fs.readdir(overlayAbs, { withFileTypes: true });
    const yamlFiles = entries
      .filter((entry) => entry.isFile() && /\.(ya?ml)$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));

    if (yamlFiles.length === 0) {
      throw new Error('overlay directory contains no .yaml/.yml files');
    }

    const sep = Buffer.from('\n---\n', 'utf8');
    const buffers = [];
    const sources = [];
    let total = 0;

    for (const name of yamlFiles) {
      const filePath = path.join(overlayAbs, name);
      const fileStat = await fs.stat(filePath);
      total += fileStat.size;
      if (buffers.length > 0) {
        total += sep.length;
      }
      if (total > maxBytes) {
        throw new Error(`Plain render output exceeds max_bytes (${total} > ${maxBytes})`);
      }
      buffers.push(await fs.readFile(filePath));
      sources.push(path.relative(repoRoot, filePath));
    }

    const combined = buffers.length === 1
      ? buffers[0]
      : Buffer.concat(
        buffers.flatMap((buf, idx) => (idx === 0 ? [buf] : [sep, buf])),
        total
      );

    return { buffer: combined, sources };
  }

  async runCommandCapture({ cwd, command, argv, env, timeoutMs, maxBytes, maxStderrBytes }) {
    const child = spawn(command, argv, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
    });

    let stdoutBuffers = [];
    let stderrBuffers = [];
    const stdoutState = { total: 0, captured: 0, buffers: stdoutBuffers, truncated: false };
    const stderrState = { total: 0, captured: 0, buffers: stderrBuffers, truncated: false };

    const capture = (chunk, state, limit) => {
      const size = chunk.length;
      state.total += size;
      if (state.captured >= limit) {
        state.truncated = true;
        return;
      }
      const remaining = limit - state.captured;
      if (size <= remaining) {
        state.buffers.push(chunk);
        state.captured += size;
        return;
      }
      state.buffers.push(chunk.subarray(0, remaining));
      state.captured += remaining;
      state.truncated = true;
    };

    child.stdout?.on('data', (chunk) => capture(chunk, stdoutState, maxBytes));
    child.stderr?.on('data', (chunk) => capture(chunk, stderrState, maxStderrBytes));

    let timedOut = false;
    let timeout;
    if (timeoutMs) {
      timeout = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGKILL');
        } catch (error) {
        }
      }, timeoutMs);
    }

    const finished = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, sig) => resolve({ code, sig }));
    });

    if (timeout) {
      clearTimeout(timeout);
    }

    const stdoutBuffer = stdoutState.captured
      ? Buffer.concat(stdoutBuffers, stdoutState.captured)
      : Buffer.alloc(0);
    const stderrBuffer = stderrState.captured
      ? Buffer.concat(stderrBuffers, stderrState.captured)
      : Buffer.alloc(0);

    return {
      exit_code: typeof finished.code === 'number' ? finished.code : 1,
      signal: finished.sig,
      timed_out: timedOut,
      stdout_bytes: stdoutState.total,
      stderr_bytes: stderrState.total,
      stdout_truncated: stdoutState.truncated,
      stderr_truncated: stderrState.truncated,
      stdout_buffer: stdoutBuffer,
      stderr_buffer: stderrBuffer,
    };
  }

  async render(args) {
    const repoRootRaw = await this.resolveRepoRoot(args);
    const repoRoot = await resolveSandboxPath(repoRootRaw, null);
    const gitRoot = await this.resolveGitRoot(repoRoot);

    const overlay = args.overlay ? this.validation.ensureString(String(args.overlay), 'overlay', { trim: false }) : null;
    const chart = args.chart ? this.validation.ensureString(String(args.chart), 'chart', { trim: false }) : null;
    const values = args.values ? this.normalizeArgs(args.values) : [];
    const requestedType = args.render_type
      ? this.validation.ensureString(String(args.render_type), 'render_type')
      : null;

    const renderType = await this.detectRenderType({
      repoRoot: gitRoot,
      renderType: requestedType,
      overlay,
      chart,
    });

    const { maxBytes, maxStderrBytes, timeoutMs } = this.resolveRenderBudgets();
    const traceId = args.trace_id || 'run';
    const spanId = args.span_id;

    let rendered;
    let sources;
    let stderrBuffer = Buffer.alloc(0);
    let stderrTruncated = false;

    if (renderType === 'plain') {
      if (!overlay) {
        throw new Error('overlay is required for render_type=plain');
      }
      const overlayAbs = await resolveSandboxPath(gitRoot, overlay, { mustExist: true });
      const plain = await this.renderPlain({ repoRoot: gitRoot, overlayAbs, maxBytes });
      rendered = plain.buffer;
      sources = plain.sources;
    } else if (renderType === 'kustomize') {
      if (!overlay) {
        throw new Error('overlay is required for render_type=kustomize');
      }

      const allowedCommands = this.resolveAllowedCommands();
      const command = this.normalizeCommand('kubectl', allowedCommands);
      this.ensureExecAllowed({ command, argv: ['kustomize'], apply: false });

      const overlayAbs = await resolveSandboxPath(gitRoot, overlay, { mustExist: true });
      const result = await this.runCommandCapture({
        cwd: gitRoot,
        command,
        argv: ['kustomize', path.relative(gitRoot, overlayAbs)],
        env: {
          ...process.env,
          ...(this.normalizeEnv(args.env) || {}),
        },
        timeoutMs,
        maxBytes,
        maxStderrBytes,
      });

      if (result.exit_code !== 0 || result.timed_out) {
        const message = result.stderr_buffer.toString('utf8').trim() || 'kubectl kustomize failed';
        throw new Error(message);
      }
      if (result.stdout_truncated) {
        throw new Error(`kubectl kustomize output exceeded max_bytes (${maxBytes})`);
      }

      rendered = result.stdout_buffer;
      stderrBuffer = result.stderr_buffer;
      stderrTruncated = result.stderr_truncated;
      sources = [overlay];
    } else if (renderType === 'helm') {
      if (!chart) {
        throw new Error('chart is required for render_type=helm');
      }

      const allowedCommands = this.resolveAllowedCommands();
      const command = this.normalizeCommand('helm', allowedCommands);
      this.ensureExecAllowed({ command, argv: ['template'], apply: false });

      const chartAbs = await resolveSandboxPath(gitRoot, chart, { mustExist: true });
      const chartRel = path.relative(gitRoot, chartAbs);
      const valueArgs = [];

      for (const file of values) {
        const valueAbs = await resolveSandboxPath(gitRoot, file, { mustExist: true });
        valueArgs.push('-f', path.relative(gitRoot, valueAbs));
      }

      const result = await this.runCommandCapture({
        cwd: gitRoot,
        command,
        argv: ['template', 'release-name', chartRel, ...valueArgs],
        env: {
          ...process.env,
          ...(this.normalizeEnv(args.env) || {}),
        },
        timeoutMs,
        maxBytes,
        maxStderrBytes,
      });

      if (result.exit_code !== 0 || result.timed_out) {
        const message = result.stderr_buffer.toString('utf8').trim() || 'helm template failed';
        throw new Error(message);
      }
      if (result.stdout_truncated) {
        throw new Error(`helm template output exceeded max_bytes (${maxBytes})`);
      }

      rendered = result.stdout_buffer;
      stderrBuffer = result.stderr_buffer;
      stderrTruncated = result.stderr_truncated;
      sources = [chart, ...values];
    } else {
      throw new Error(`Unsupported render_type: ${renderType}`);
    }

    if (!rendered || !rendered.length) {
      throw new Error('Render produced empty output');
    }

    const extractedImages = extractK8sImages(rendered.toString('utf8'));
    const imagesRef = await this.writeArtifact(
      'images.json',
      Buffer.from(`${JSON.stringify(extractedImages, null, 2)}\n`, 'utf8'),
      { traceId, spanId, truncated: false }
    );

    const renderRef = await this.writeArtifact('render.yaml', rendered, { traceId, spanId, truncated: false });

    const stderrRef = stderrBuffer.length
      ? await this.writeArtifact('render.stderr.log', stderrBuffer, { traceId, spanId, truncated: stderrTruncated })
      : null;

    const { maxInlineBytes } = this.resolveExecBudgets();
    const inlineLimit = Math.min(maxInlineBytes, 64 * 1024);
    const renderInline = !renderRef
      ? rendered.subarray(0, inlineLimit).toString('utf8').trimEnd()
      : undefined;
    const stderrInline = !stderrRef && stderrBuffer.length
      ? stderrBuffer.subarray(0, inlineLimit).toString('utf8').trimEnd()
      : undefined;

    const MAX_IMAGES_INLINE = 200;
    const imagesInline = extractedImages.images.length > MAX_IMAGES_INLINE
      ? extractedImages.images.slice(0, MAX_IMAGES_INLINE)
      : extractedImages.images;

    return {
      success: true,
      repo_root: gitRoot,
      render_type: renderType,
      sources: sources || [],
      render_ref: renderRef,
      render_inline: renderInline,
      render_inline_truncated: !renderRef && rendered.length > inlineLimit,
      stderr_ref: stderrRef,
      stderr_inline: stderrInline,
      stderr_inline_truncated: !stderrRef && stderrBuffer.length > inlineLimit,
      images: imagesInline,
      images_truncated: extractedImages.images.length > MAX_IMAGES_INLINE,
      images_summary: extractedImages.summary,
      images_violations: extractedImages.violations,
      images_ref: imagesRef,
    };
  }

  parseRemoteProvider(remoteUrl) {
    if (!remoteUrl || typeof remoteUrl !== 'string') {
      return { provider: 'unknown', owner: null, repo: null };
    }

    const normalized = remoteUrl.trim();
    const lower = normalized.toLowerCase();
    const provider = lower.includes('github.com')
      ? 'github'
      : lower.includes('gitlab')
        ? 'gitlab'
        : 'unknown';

    let owner = null;
    let repo = null;

    const stripGit = (value) => value.endsWith('.git') ? value.slice(0, -4) : value;

    if (normalized.startsWith('git@')) {
      const idx = normalized.indexOf(':');
      if (idx !== -1) {
        const rest = stripGit(normalized.slice(idx + 1));
        const parts = rest.split('/');
        if (parts.length >= 2) {
          owner = parts[0];
          repo = parts[1];
        }
      }
    } else {
      try {
        const url = new URL(normalized);
        const parts = stripGit(url.pathname.replace(/^\/+/, '')).split('/');
        if (parts.length >= 2) {
          owner = parts[0];
          repo = parts[1];
        }
      } catch (error) {
      }
    }

    return { provider, owner, repo };
  }

  extractPatchPaths(patch) {
    const paths = new Set();
    const text = typeof patch === 'string' ? patch : String(patch ?? '');
    const lines = text.split(/\r?\n/);

    for (const line of lines) {
      if (line.startsWith('diff --git ')) {
        const parts = line.split(' ');
        if (parts.length >= 4) {
          const a = parts[2];
          const b = parts[3];
          for (const token of [a, b]) {
            if (token === '/dev/null') {
              continue;
            }
            if (token.startsWith('a/')) {
              paths.add(token.slice(2));
            } else if (token.startsWith('b/')) {
              paths.add(token.slice(2));
            }
          }
        }
        continue;
      }

      if (line.startsWith('+++ ') || line.startsWith('--- ')) {
        const token = line.slice(4).trim();
        if (!token || token === '/dev/null') {
          continue;
        }
        if (token.startsWith('a/')) {
          paths.add(token.slice(2));
        } else if (token.startsWith('b/')) {
          paths.add(token.slice(2));
        }
      }
    }

    return Array.from(paths);
  }

  async ensurePatchSafe(repoRoot, patch) {
    const paths = this.extractPatchPaths(patch);
    for (const rel of paths) {
      if (!rel || typeof rel !== 'string') {
        continue;
      }

      if (rel.includes('\0')) {
        throw new Error('Patch contains null bytes in path');
      }
      if (rel.startsWith('/') || rel.includes('\\')) {
        throw new Error(`Patch path is not allowed: ${rel}`);
      }
      if (rel.split('/').includes('..')) {
        throw new Error(`Patch path escapes repo_root: ${rel}`);
      }

      await resolveSandboxPath(repoRoot, rel, { mustExist: false });
    }
  }

  async repoInfo(args) {
    const repoRootRaw = await this.resolveRepoRoot(args);
    const repoRoot = await resolveSandboxPath(repoRootRaw, null);
    const gitRoot = await this.resolveGitRoot(repoRoot);

    const { maxCaptureBytes, timeoutMs } = this.resolveExecBudgets();
    const run = (argv) => this.runGit({ cwd: gitRoot, argv, timeoutMs, maxCaptureBytes: Math.min(maxCaptureBytes, 64 * 1024) });

    const head = await run(['rev-parse', 'HEAD']);
    const branch = await run(['rev-parse', '--abbrev-ref', 'HEAD']);
    const status = await run(['status', '--porcelain']);
    const remotes = await run(['remote', '-v']);

    const sha = head.exit_code === 0 ? head.stdout_buffer.toString('utf8').trim() : null;
    const branchName = branch.exit_code === 0 ? branch.stdout_buffer.toString('utf8').trim() : null;
    const dirty = status.exit_code === 0 ? status.stdout_buffer.toString('utf8').trim().length > 0 : null;

    const remoteLines = remotes.exit_code === 0
      ? remotes.stdout_buffer.toString('utf8').trim().split(/\r?\n/).filter(Boolean)
      : [];

    const remotesByName = {};
    for (const line of remoteLines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2) {
        const name = parts[0];
        const url = parts[1];
        if (!remotesByName[name]) {
          remotesByName[name] = { name, urls: [] };
        }
        if (!remotesByName[name].urls.includes(url)) {
          remotesByName[name].urls.push(url);
        }
      }
    }

    let defaultBranch = null;
    const originHead = await run(['symbolic-ref', 'refs/remotes/origin/HEAD']).catch(() => null);
    if (originHead && originHead.exit_code === 0) {
      const ref = originHead.stdout_buffer.toString('utf8').trim();
      const parts = ref.split('/');
      defaultBranch = parts[parts.length - 1] || null;
    }

    const originUrl = remotesByName.origin?.urls?.[0];
    const provider = this.parseRemoteProvider(originUrl);

    const log = await run(['log', '-n', '5', '--pretty=format:%H\t%s']).catch(() => null);
    const commits = log && log.exit_code === 0
      ? log.stdout_buffer
        .toString('utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          const [hash, ...rest] = line.split('\t');
          return { sha: hash, subject: rest.join('\t') };
        })
      : [];

    return {
      success: true,
      repo_root: gitRoot,
      branch: branchName,
      head: sha,
      dirty,
      default_branch: defaultBranch,
      remotes: Object.values(remotesByName),
      provider,
      recent_commits: commits,
    };
  }

  async gitDiff(args) {
    const repoRootRaw = await this.resolveRepoRoot(args);
    const repoRoot = await resolveSandboxPath(repoRootRaw, null);
    const gitRoot = await this.resolveGitRoot(repoRoot);

    const { maxCaptureBytes, timeoutMs } = this.resolveExecBudgets();
    const diff = await this.runGit({ cwd: gitRoot, argv: ['diff'], timeoutMs, maxCaptureBytes });
    if (diff.exit_code !== 0) {
      throw new Error(diff.stderr_buffer.toString('utf8').trim() || 'git diff failed');
    }

    const diffSha256 = crypto
      .createHash('sha256')
      .update(diff.stdout_buffer)
      .digest('hex');

    const stat = await this.runGit({ cwd: gitRoot, argv: ['diff', '--stat'], timeoutMs, maxCaptureBytes: Math.min(maxCaptureBytes, 64 * 1024) });
    const diffstat = stat.exit_code === 0 ? stat.stdout_buffer.toString('utf8').trimEnd() : null;

    const traceId = args.trace_id || 'run';
    const spanId = args.span_id;
    const diffRef = await this.writeArtifact('diff.patch', diff.stdout_buffer, { traceId, spanId, truncated: diff.stdout_truncated });

    return {
      success: true,
      repo_root: gitRoot,
      diffstat,
      diff_ref: diffRef,
      diff_truncated: diff.stdout_truncated,
      diff_sha256: diffSha256,
      stderr: diff.stderr_buffer.toString('utf8').trimEnd() || undefined,
    };
  }

  async applyPatch(args) {
    if (args.apply !== true) {
      throw new Error('apply=true is required for apply_patch');
    }

    const patch = this.validation.ensureString(String(args.patch ?? ''), 'patch', { trim: false });
    this.security.ensureSizeFits(patch, { maxBytes: this.resolvePatchBudgetBytes() });

    const repoRootRaw = await this.resolveRepoRoot(args);
    const repoRoot = await resolveSandboxPath(repoRootRaw, null);
    const gitRoot = await this.resolveGitRoot(repoRoot);

    await this.ensurePatchSafe(gitRoot, patch);

    const traceId = args.trace_id || 'run';
    const spanId = args.span_id;
    const patchRef = await this.writeArtifact('patch.diff', Buffer.from(patch, 'utf8'), { traceId, spanId, truncated: false });

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-git-patch-'));
    const tmpPath = path.join(tmpDir, 'patch.diff');
    try {
      await fs.writeFile(tmpPath, patch, { encoding: 'utf8', mode: 0o600 });

      const { maxCaptureBytes, timeoutMs } = this.resolveExecBudgets();
      const check = await this.runGit({ cwd: gitRoot, argv: ['apply', '--check', tmpPath], timeoutMs, maxCaptureBytes: Math.min(maxCaptureBytes, 64 * 1024) });
      if (check.exit_code !== 0) {
        throw new Error(check.stderr_buffer.toString('utf8').trim() || 'git apply --check failed');
      }

      const applied = await this.runGit({ cwd: gitRoot, argv: ['apply', '--whitespace=nowarn', tmpPath], timeoutMs, maxCaptureBytes: Math.min(maxCaptureBytes, 64 * 1024) });
      if (applied.exit_code !== 0) {
        throw new Error(applied.stderr_buffer.toString('utf8').trim() || 'git apply failed');
      }

      const stat = await this.runGit({ cwd: gitRoot, argv: ['diff', '--stat'], timeoutMs, maxCaptureBytes: Math.min(maxCaptureBytes, 64 * 1024) });
      const diffstat = stat.exit_code === 0 ? stat.stdout_buffer.toString('utf8').trimEnd() : null;

      return {
        success: true,
        repo_root: gitRoot,
        patch_ref: patchRef,
        diffstat,
      };
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => null);
    }
  }

  async gitCommit(args) {
    if (args.apply !== true) {
      throw new Error('apply=true is required for git_commit');
    }

    const message = this.validation.ensureString(String(args.message ?? ''), 'message', { trim: false });
    this.security.ensureSizeFits(message, { maxBytes: this.resolvePatchBudgetBytes() });

    const repoRootRaw = await this.resolveRepoRoot(args);
    const repoRoot = await resolveSandboxPath(repoRootRaw, null);
    const gitRoot = await this.resolveGitRoot(repoRoot);

    const { maxCaptureBytes, timeoutMs } = this.resolveExecBudgets();

    const add = await this.runGit({ cwd: gitRoot, argv: ['add', '-A'], timeoutMs, maxCaptureBytes: Math.min(maxCaptureBytes, 64 * 1024) });
    if (add.exit_code !== 0) {
      throw new Error(add.stderr_buffer.toString('utf8').trim() || 'git add failed');
    }

    const staged = await this.runGit({ cwd: gitRoot, argv: ['diff', '--cached', '--name-only'], timeoutMs, maxCaptureBytes: Math.min(maxCaptureBytes, 64 * 1024) });
    const stagedList = staged.exit_code === 0
      ? staged.stdout_buffer.toString('utf8').trim().split(/\r?\n/).filter(Boolean)
      : [];
    if (stagedList.length === 0) {
      throw new Error('No staged changes to commit');
    }

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-git-commit-'));
    const msgPath = path.join(tmpDir, 'message.txt');
    try {
      await fs.writeFile(msgPath, message, { encoding: 'utf8', mode: 0o600 });

      const commit = await this.runGit({
        cwd: gitRoot,
        argv: ['-c', 'commit.gpgSign=false', 'commit', '-F', msgPath],
        timeoutMs,
        maxCaptureBytes: maxCaptureBytes,
      });

      if (commit.exit_code !== 0) {
        throw new Error(commit.stderr_buffer.toString('utf8').trim() || 'git commit failed');
      }

      const head = await this.runGit({ cwd: gitRoot, argv: ['rev-parse', 'HEAD'], timeoutMs, maxCaptureBytes: Math.min(maxCaptureBytes, 64 * 1024) });
      if (head.exit_code !== 0) {
        throw new Error(head.stderr_buffer.toString('utf8').trim() || 'git rev-parse HEAD failed');
      }

      return {
        success: true,
        repo_root: gitRoot,
        sha: head.stdout_buffer.toString('utf8').trim(),
        committed_files: stagedList,
      };
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => null);
    }
  }

  async gitRevert(args) {
    if (args.apply !== true) {
      throw new Error('apply=true is required for git_revert');
    }

    const sha = this.validation.ensureString(String(args.sha ?? ''), 'sha');
    const mainline = args.mainline === undefined || args.mainline === null || args.mainline === ''
      ? null
      : Number(args.mainline);
    if (mainline !== null) {
      if (!Number.isFinite(mainline) || mainline <= 0) {
        throw new Error('mainline must be a positive integer');
      }
    }

    const repoRootRaw = await this.resolveRepoRoot(args);
    const repoRoot = await resolveSandboxPath(repoRootRaw, null);
    const gitRoot = await this.resolveGitRoot(repoRoot);

    const { maxCaptureBytes, timeoutMs } = this.resolveExecBudgets();

    const argv = ['-c', 'commit.gpgSign=false', 'revert', '--no-edit'];
    if (mainline !== null) {
      argv.push('-m', String(Math.floor(mainline)));
    }
    argv.push(sha);

    const revert = await this.runGit({ cwd: gitRoot, argv, timeoutMs, maxCaptureBytes });
    if (revert.exit_code !== 0) {
      throw new Error(revert.stderr_buffer.toString('utf8').trim() || 'git revert failed');
    }

    const traceId = args.trace_id || 'run';
    const spanId = args.span_id;
    const revertLog = await this.writeArtifact('revert.log', Buffer.concat([revert.stdout_buffer, revert.stderr_buffer]), {
      traceId,
      spanId,
      truncated: revert.stdout_truncated || revert.stderr_truncated,
    });

    const head = await this.runGit({
      cwd: gitRoot,
      argv: ['rev-parse', 'HEAD'],
      timeoutMs,
      maxCaptureBytes: Math.min(maxCaptureBytes, 64 * 1024),
    });
    if (head.exit_code !== 0) {
      throw new Error(head.stderr_buffer.toString('utf8').trim() || 'git rev-parse HEAD failed');
    }

    return {
      success: true,
      repo_root: gitRoot,
      reverted_sha: sha,
      head: head.stdout_buffer.toString('utf8').trim(),
      revert_ref: revertLog,
    };
  }

  async gitPush(args) {
    if (args.apply !== true) {
      throw new Error('apply=true is required for git_push');
    }

    const repoRootRaw = await this.resolveRepoRoot(args);
    const repoRoot = await resolveSandboxPath(repoRootRaw, null);
    const gitRoot = await this.resolveGitRoot(repoRoot);

    const remote = args.remote ? this.validation.ensureString(String(args.remote), 'remote') : 'origin';

    const { maxCaptureBytes, timeoutMs } = this.resolveExecBudgets();

    let branch = args.branch ? this.validation.ensureString(String(args.branch), 'branch') : null;
    if (!branch) {
      const current = await this.runGit({ cwd: gitRoot, argv: ['rev-parse', '--abbrev-ref', 'HEAD'], timeoutMs, maxCaptureBytes: Math.min(maxCaptureBytes, 64 * 1024) });
      if (current.exit_code !== 0) {
        throw new Error(current.stderr_buffer.toString('utf8').trim() || 'Unable to resolve current branch');
      }
      branch = current.stdout_buffer.toString('utf8').trim();
      if (!branch || branch === 'HEAD') {
        throw new Error('Detached HEAD cannot be pushed without explicit branch');
      }
    }

    const push = await this.runGit({ cwd: gitRoot, argv: ['push', remote, branch], timeoutMs, maxCaptureBytes });
    if (push.exit_code !== 0) {
      throw new Error(push.stderr_buffer.toString('utf8').trim() || 'git push failed');
    }

    const traceId = args.trace_id || 'run';
    const spanId = args.span_id;
    const pushLog = await this.writeArtifact('push.log', Buffer.concat([push.stdout_buffer, push.stderr_buffer]), {
      traceId,
      spanId,
      truncated: push.stdout_truncated || push.stderr_truncated,
    });

    return {
      success: true,
      repo_root: gitRoot,
      remote,
      branch,
      push_ref: pushLog,
    };
  }

  ensureExecAllowed({ command, argv, apply }) {
    if (apply) {
      return;
    }

    if (!argv || argv.length === 0) {
      throw new Error(`${command} subcommand is required`);
    }

    let subcommand = argv[0];
    let subcommandIndex = 0;
    if (command === 'kubectl') {
      const found = findKubectlToken(argv, 0);
      if (!found) {
        throw new Error('kubectl subcommand is required');
      }
      subcommand = found.token;
      subcommandIndex = found.index;
    } else {
      if (typeof subcommand !== 'string' || !subcommand.trim()) {
        throw new Error(`${command} subcommand is required`);
      }
      if (subcommand.startsWith('-')) {
        throw new Error(`${command} subcommand must be the first argument when apply=false`);
      }
    }

    if (command === 'git') {
      if (!READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) {
        throw new Error(`git ${subcommand} requires apply=true`);
      }
      return;
    }

    if (command === 'kubectl') {
      if (READ_ONLY_EXEC_SUBCOMMANDS.kubectl?.has(subcommand)) {
        return;
      }
      const nested = READ_ONLY_EXEC_SUBSUBCOMMANDS.kubectl?.[subcommand];
      if (nested) {
        const second = findKubectlToken(argv, subcommandIndex + 1);
        if (!second) {
          throw new Error(`kubectl ${subcommand} subcommand is required`);
        }
        if (!nested.has(second.token)) {
          throw new Error(`kubectl ${subcommand} ${second.token} requires apply=true`);
        }
        return;
      }
      throw new Error(`kubectl ${subcommand} requires apply=true`);
    }

    const allowed = READ_ONLY_EXEC_SUBCOMMANDS[command];
    if (!allowed || !allowed.has(subcommand)) {
      throw new Error(`${command} ${subcommand} requires apply=true`);
    }
  }

  async exec(args) {
    const allowedCommands = this.resolveAllowedCommands();
    const { maxCaptureBytes, maxInlineBytes, timeoutMs } = this.resolveExecBudgets();

    const apply = args.apply === true;
    const command = this.normalizeCommand(args.command, allowedCommands);
    const argv = this.normalizeArgs(args.args);

    if (command === 'git') {
      const first = argv[0];
      if (first === '-c' || first === '--config' || first === '--config-env') {
        throw new Error('git exec forbids global -c/--config flags');
      }
      if (typeof first === 'string' && first.startsWith('--config=')) {
        throw new Error('git exec forbids global --config flags');
      }
    }

    this.ensureExecAllowed({ command, argv, apply });

    const repoRootRaw = await this.resolveRepoRoot(args);
    const repoRoot = await resolveSandboxPath(repoRootRaw, null);
    const cwd = args.cwd
      ? await resolveSandboxPath(repoRoot, this.validation.ensureString(String(args.cwd), 'cwd', { trim: false }))
      : repoRoot;

    const env = {
      ...process.env,
      ...(this.normalizeEnv(args.env) || {}),
    };

    const stdin = args.stdin;
    if (stdin !== undefined && stdin !== null) {
      this.security.ensureSizeFits(String(stdin), { maxBytes: maxInlineBytes * 32 });
    }

    const started = Date.now();
    const child = spawn(command, command === 'git' ? ['--no-pager', ...argv] : argv, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
    });

    if (stdin !== undefined && stdin !== null) {
      child.stdin?.end(String(stdin));
    } else {
      child.stdin?.end();
    }

    let stdoutTotal = 0;
    let stderrTotal = 0;
    let stdoutBuffers = [];
    let stderrBuffers = [];
    let stdoutCaptured = 0;
    let stderrCaptured = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;

    const capture = (chunk, state) => {
      const size = chunk.length;
      state.total += size;
      if (state.captured >= maxCaptureBytes) {
        state.truncated = true;
        return;
      }
      const remaining = maxCaptureBytes - state.captured;
      if (size <= remaining) {
        state.buffers.push(chunk);
        state.captured += size;
        return;
      }
      state.buffers.push(chunk.subarray(0, remaining));
      state.captured += remaining;
      state.truncated = true;
    };

    const stdoutState = { total: 0, captured: 0, buffers: stdoutBuffers, truncated: false };
    const stderrState = { total: 0, captured: 0, buffers: stderrBuffers, truncated: false };

    if (child.stdout) {
      child.stdout.on('data', (chunk) => capture(chunk, stdoutState));
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk) => capture(chunk, stderrState));
    }

    let timeout;
    if (timeoutMs) {
      timeout = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGKILL');
        } catch (error) {
        }
      }, timeoutMs);
    }

    let exitCode = 1;
    let signal;

    const finished = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, sig) => resolve({ code, sig }));
    });

    exitCode = typeof finished.code === 'number' ? finished.code : 1;
    signal = finished.sig;

    if (timeout) {
      clearTimeout(timeout);
    }

    stdoutTotal = stdoutState.total;
    stderrTotal = stderrState.total;
    stdoutCaptured = stdoutState.captured;
    stderrCaptured = stderrState.captured;
    stdoutTruncated = stdoutState.truncated;
    stderrTruncated = stderrState.truncated;

    const stdoutBuffer = stdoutCaptured ? Buffer.concat(stdoutBuffers, stdoutCaptured) : Buffer.alloc(0);
    const stderrBuffer = stderrCaptured ? Buffer.concat(stderrBuffers, stderrCaptured) : Buffer.alloc(0);

    const contextRoot = resolveContextRepoRoot();
    const traceId = args.trace_id || 'run';
    const spanId = args.span_id;

    const stdoutArtifact = contextRoot && stdoutBuffer.length
      ? await writeBinaryArtifact(
        contextRoot,
        buildToolCallFileRef({ traceId, spanId, filename: 'stdout.log' }),
        stdoutBuffer
      )
      : null;

    const stderrArtifact = contextRoot && stderrBuffer.length
      ? await writeBinaryArtifact(
        contextRoot,
        buildToolCallFileRef({ traceId, spanId, filename: 'stderr.log' }),
        stderrBuffer
      )
      : null;

    const inline = args.inline === true;
    const decodeInline = (buffer) => {
      if (!inline || !buffer.length) {
        return { text: undefined, truncated: false };
      }
      const sliced = buffer.length > maxInlineBytes ? buffer.subarray(0, maxInlineBytes) : buffer;
      return {
        text: sliced.toString('utf8').trimEnd(),
        truncated: buffer.length > maxInlineBytes,
      };
    };

    const stdoutInline = decodeInline(stdoutBuffer);
    const stderrInline = decodeInline(stderrBuffer);

    let stdoutJson;
    let stdoutJsonError;
    if (args.parse_json === true) {
      if (stdoutTruncated) {
        stdoutJsonError = 'stdout truncated';
      } else if (stdoutBuffer.length) {
        try {
          stdoutJson = JSON.parse(stdoutBuffer.toString('utf8'));
        } catch (error) {
          stdoutJsonError = error.message;
        }
      }
    }

    this.stats.exec += 1;

    return {
      success: exitCode === 0 && !timedOut,
      repo_root: repoRoot,
      cwd,
      command,
      args: argv,
      exit_code: exitCode,
      signal,
      timed_out: timedOut,
      duration_ms: Date.now() - started,
      stdout_bytes: stdoutTotal,
      stderr_bytes: stderrTotal,
      stdout_captured_bytes: stdoutCaptured,
      stderr_captured_bytes: stderrCaptured,
      stdout_truncated: stdoutTruncated,
      stderr_truncated: stderrTruncated,
      stdout_inline: stdoutInline.text,
      stderr_inline: stderrInline.text,
      stdout_inline_truncated: stdoutInline.truncated,
      stderr_inline_truncated: stderrInline.truncated,
      stdout_json: stdoutJson,
      stdout_json_error: stdoutJsonError,
      stdout_ref: stdoutArtifact
        ? { uri: stdoutArtifact.uri, rel: stdoutArtifact.rel, bytes: stdoutArtifact.bytes, truncated: stdoutTruncated }
        : null,
      stderr_ref: stderrArtifact
        ? { uri: stderrArtifact.uri, rel: stderrArtifact.rel, bytes: stderrArtifact.bytes, truncated: stderrTruncated }
        : null,
    };
  }

  getStats() {
    return { ...this.stats };
  }
}

module.exports = RepoManager;
