#!/usr/bin/env node

/**
 * 🛡️ Policy service (GitOps hardening).
 */

const crypto = require('node:crypto');

const ToolError = require('../errors/ToolError.cjs');

const DEFAULT_LOCK_TTL_MS = 15 * 60_000;
const MAX_LOCK_TTL_MS = 24 * 60 * 60_000;

const DAY_INDEX = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

function ensureObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function ensureOptionalObject(value, label) {
  if (value === undefined || value === null) {
    return null;
  }
  return ensureObject(value, label);
}

function normalizeStringArray(value) {
  if (value === undefined || value === null) {
    return null;
  }
  if (!Array.isArray(value)) {
    throw new Error('must be an array of strings');
  }
  const items = value
    .map((entry) => (entry === undefined || entry === null ? '' : String(entry).trim()))
    .filter(Boolean);
  return items.length > 0 ? items : null;
}

function parseTimeMinutes(raw, label) {
  if (raw === undefined || raw === null || raw === '') {
    return null;
  }
  const value = String(raw).trim();
  if (value === '24:00') {
    return 24 * 60;
  }
  const match = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    throw new Error(`${label} must be HH:MM (24h)`);
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || hours < 0 || hours > 23) {
    throw new Error(`${label} hours must be 0-23`);
  }
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 59) {
    throw new Error(`${label} minutes must be 0-59`);
  }
  return hours * 60 + minutes;
}

function normalizeDays(value) {
  if (value === undefined || value === null) {
    return null;
  }
  if (!Array.isArray(value)) {
    throw new Error('days must be an array');
  }
  const days = new Set();
  for (const raw of value) {
    if (raw === '*' || raw === 'all') {
      return null;
    }
    const normalized = typeof raw === 'string' ? raw.trim().toLowerCase() : raw;
    if (typeof normalized === 'number') {
      if (!Number.isInteger(normalized) || normalized < 0 || normalized > 6) {
        throw new Error('days entries must be 0-6');
      }
      days.add(normalized);
      continue;
    }
    if (typeof normalized === 'string') {
      const idx = DAY_INDEX[normalized.slice(0, 3)];
      if (idx === undefined) {
        throw new Error(`Unknown day: ${raw}`);
      }
      days.add(idx);
      continue;
    }
    throw new Error('days entries must be strings or numbers');
  }
  return days.size > 0 ? Array.from(days) : null;
}

function normalizeChangeWindows(raw) {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (!Array.isArray(raw)) {
    throw new Error('change_windows must be an array');
  }
  const windows = [];
  for (const entry of raw) {
    const window = ensureObject(entry, 'change_windows entry');
    const start = parseTimeMinutes(window.start, 'change_windows.start');
    const end = parseTimeMinutes(window.end, 'change_windows.end');
    const days = normalizeDays(window.days);
    const tz = window.tz === undefined || window.tz === null || window.tz === ''
      ? 'UTC'
      : String(window.tz).trim();
    if (tz !== 'UTC') {
      throw new Error('change_windows.tz currently only supports UTC');
    }
    windows.push({
      days,
      start: start ?? 0,
      end: end ?? 24 * 60,
      tz,
    });
  }
  return windows;
}

function isWithinWindowsUtc(now, windows) {
  if (!windows) {
    return true;
  }
  if (!Array.isArray(windows) || windows.length === 0) {
    return false;
  }

  const day = now.getUTCDay();
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();

  for (const window of windows) {
    const days = window.days;
    const start = window.start;
    const end = window.end;

    const dayAllowed = !days || days.includes(day);
    const prevDayAllowed = !days || days.includes((day + 6) % 7);

    if (start <= end) {
      if (dayAllowed && minutes >= start && minutes < end) {
        return true;
      }
      continue;
    }

    // Cross-midnight window: D start→24:00 OR (D+1) 00:00→end.
    if ((dayAllowed && minutes >= start) || (prevDayAllowed && minutes < end)) {
      return true;
    }
  }

  return false;
}

function computeRepoRootKey(repoRoot) {
  const hash = crypto.createHash('sha256').update(String(repoRoot || '')).digest('hex').slice(0, 16);
  return `repo:${hash}`;
}

class PolicyService {
  constructor(logger, validation, stateService) {
    this.logger = logger.child('policy');
    this.validation = validation;
    this.stateService = stateService;
  }

  resolvePolicy(inputs, projectContext) {
    const direct = ensureOptionalObject(inputs?.policy, 'policy');
    if (direct) {
      return direct;
    }

    const fromTarget = ensureOptionalObject(inputs?.target?.policy, 'target.policy');
    if (fromTarget) {
      return fromTarget;
    }

    const fromProject = ensureOptionalObject(projectContext?.target?.policy, 'target.policy');
    if (fromProject) {
      return fromProject;
    }

    return null;
  }

  normalizePolicy(policy) {
    const payload = ensureObject(policy, 'policy');

    const mode = payload.mode === undefined || payload.mode === null || payload.mode === ''
      ? null
      : String(payload.mode).trim();

    const allowIntents = normalizeStringArray(payload.allow?.intents);
    const allowMerge = payload.allow?.merge;
    if (allowMerge !== undefined && typeof allowMerge !== 'boolean') {
      throw new Error('policy.allow.merge must be a boolean');
    }

    const allowedRemotes = normalizeStringArray(payload.repo?.allowed_remotes);
    const allowedNamespaces = normalizeStringArray(payload.kubernetes?.allowed_namespaces);

    const changeWindows = normalizeChangeWindows(payload.change_windows);

    const lockRaw = payload.lock === undefined || payload.lock === null ? null : ensureOptionalObject(payload.lock, 'policy.lock');
    const lockEnabled = lockRaw?.enabled === undefined ? true : lockRaw.enabled;
    if (lockEnabled !== undefined && typeof lockEnabled !== 'boolean') {
      throw new Error('policy.lock.enabled must be a boolean');
    }

    const ttlMsRaw = lockRaw?.ttl_ms;
    const ttlMs = ttlMsRaw === undefined || ttlMsRaw === null || ttlMsRaw === ''
      ? DEFAULT_LOCK_TTL_MS
      : Number(ttlMsRaw);

    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error('policy.lock.ttl_ms must be a positive number');
    }

    return {
      mode,
      allow: {
        intents: allowIntents,
        merge: allowMerge,
      },
      repo: {
        allowed_remotes: allowedRemotes,
      },
      kubernetes: {
        allowed_namespaces: allowedNamespaces,
      },
      change_windows: changeWindows,
      lock: {
        enabled: Boolean(lockEnabled),
        ttl_ms: Math.min(Math.floor(ttlMs), MAX_LOCK_TTL_MS),
      },
    };
  }

  assertGitOpsWriteAllowed({ intentType, inputs, policy, now }) {
    if (!policy) {
      throw ToolError.denied({
        code: 'POLICY_REQUIRED',
        message: 'GitOps write intents require policy',
        hint: 'Provide inputs.policy (mode=operatorless) or configure target.policy.',
      });
    }

    if (policy.mode !== 'operatorless') {
      throw ToolError.denied({
        code: 'POLICY_MODE_REQUIRED',
        message: 'policy.mode=operatorless is required for GitOps write intents',
        hint: 'Set inputs.policy.mode="operatorless" (or target.policy.mode) and retry.',
      });
    }

    if (policy.allow.intents && !policy.allow.intents.includes(intentType)) {
      throw ToolError.denied({
        code: 'POLICY_DENIED_INTENT',
        message: `policy denies intent: ${intentType}`,
        hint: 'Ask an operator to allow this intent in policy.allow.intents or choose an allowed intent.',
        details: { intent_type: intentType },
      });
    }

    if ((intentType === 'gitops.propose' || intentType === 'gitops.release') && inputs?.merge === true) {
      if (policy.allow.merge === false) {
        throw ToolError.denied({
          code: 'POLICY_DENIED_MERGE',
          message: 'policy denies merge',
          hint: 'Set inputs.merge=false or ask an operator to allow merges (policy.allow.merge).',
        });
      }
    }

    if (policy.repo.allowed_remotes) {
      const remote = inputs?.remote ? String(inputs.remote).trim() : 'origin';
      if (!policy.repo.allowed_remotes.includes(remote)) {
        throw ToolError.denied({
          code: 'POLICY_DENIED_REMOTE',
          message: `policy denies git remote: ${remote}`,
          hint: 'Use an allowed remote or ask an operator to add it to policy.repo.allowed_remotes.',
          details: { remote },
        });
      }
    }

    if (policy.kubernetes.allowed_namespaces && inputs?.namespace) {
      const namespace = String(inputs.namespace).trim();
      if (!policy.kubernetes.allowed_namespaces.includes(namespace)) {
        throw ToolError.denied({
          code: 'POLICY_DENIED_NAMESPACE',
          message: `policy denies namespace: ${namespace}`,
          hint: 'Choose an allowed namespace or ask an operator to add it to policy.kubernetes.allowed_namespaces.',
          details: { namespace },
        });
      }
    }

    if (!isWithinWindowsUtc(now, policy.change_windows)) {
      throw ToolError.denied({
        code: 'POLICY_CHANGE_WINDOW',
        message: 'policy denies write outside change window',
        hint: 'Wait for the next change window or ask an operator to adjust policy.change_windows.',
      });
    }
  }

  assertRepoWriteAllowed({ action, inputs, policy, now }) {
    if (!policy) {
      return;
    }

    if (policy.mode !== 'operatorless') {
      throw ToolError.denied({
        code: 'POLICY_MODE_REQUIRED',
        message: 'policy.mode=operatorless is required for repo write operations',
        hint: 'Set policy.mode="operatorless" (in inputs.policy or target.policy) and retry.',
        details: { action },
      });
    }

    if (policy.repo.allowed_remotes && inputs?.remote !== undefined) {
      const remote = inputs?.remote ? String(inputs.remote).trim() : 'origin';
      if (!policy.repo.allowed_remotes.includes(remote)) {
        throw ToolError.denied({
          code: 'POLICY_DENIED_REMOTE',
          message: `policy denies git remote: ${remote}`,
          hint: 'Use an allowed remote or ask an operator to add it to policy.repo.allowed_remotes.',
          details: { remote, action },
        });
      }
    }

    if (!isWithinWindowsUtc(now, policy.change_windows)) {
      throw ToolError.denied({
        code: 'POLICY_CHANGE_WINDOW',
        message: 'policy denies write outside change window',
        hint: 'Wait for the next change window or ask an operator to adjust policy.change_windows.',
        details: { action },
      });
    }
  }

  assertKubectlWriteAllowed({ inputs, policy, now }) {
    if (!policy) {
      return;
    }

    if (policy.mode !== 'operatorless') {
      throw ToolError.denied({
        code: 'POLICY_MODE_REQUIRED',
        message: 'policy.mode=operatorless is required for kubectl write operations',
        hint: 'Set policy.mode="operatorless" (in inputs.policy or target.policy) and retry.',
      });
    }

    if (policy.kubernetes.allowed_namespaces) {
      const namespace = inputs?.namespace ? String(inputs.namespace).trim() : '';
      if (!namespace) {
        throw ToolError.denied({
          code: 'POLICY_NAMESPACE_REQUIRED',
          message: 'policy requires explicit namespace for kubectl write operations',
          hint: 'Pass -n/--namespace (or use a tool that accepts namespace explicitly) and retry.',
          details: { allowed_namespaces: policy.kubernetes.allowed_namespaces },
        });
      }
      if (!policy.kubernetes.allowed_namespaces.includes(namespace)) {
        throw ToolError.denied({
          code: 'POLICY_DENIED_NAMESPACE',
          message: `policy denies namespace: ${namespace}`,
          hint: 'Choose an allowed namespace or ask an operator to add it to policy.kubernetes.allowed_namespaces.',
          details: { namespace },
        });
      }
    }

    if (!isWithinWindowsUtc(now, policy.change_windows)) {
      throw ToolError.denied({
        code: 'POLICY_CHANGE_WINDOW',
        message: 'policy denies write outside change window',
        hint: 'Wait for the next change window or ask an operator to adjust policy.change_windows.',
      });
    }
  }

  buildLockKey({ projectName, targetName, repoRoot }) {
    if (projectName && targetName) {
      return `gitops.lock.project:${projectName}:${targetName}`;
    }
    if (repoRoot) {
      return `gitops.lock.${computeRepoRootKey(repoRoot)}`;
    }
    return null;
  }

  async acquireLock({ key, traceId, ttlMs, meta }) {
    if (!this.stateService) {
      throw new Error('state service is not available for lock enforcement');
    }

    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const expiresIso = new Date(now + ttlMs).toISOString();

    const existing = await this.stateService.get(key, 'persistent');
    const lock = existing?.value;

    const parseExpires = (value) => {
      if (!value || typeof value !== 'string') {
        return null;
      }
      const ts = Date.parse(value);
      return Number.isFinite(ts) ? ts : null;
    };

    const expired = (current) => {
      if (!current || typeof current !== 'object') {
        return true;
      }
      const expiresAt = parseExpires(current.expires_at);
      if (expiresAt === null) {
        return true;
      }
      return expiresAt <= now;
    };

    if (lock && typeof lock === 'object' && !expired(lock)) {
      if (lock.trace_id && String(lock.trace_id) === String(traceId)) {
        const nextCount = Math.max(1, Number(lock.count) || 1) + 1;
        const next = {
          ...lock,
          count: nextCount,
          updated_at: nowIso,
          expires_at: expiresIso,
        };
        await this.stateService.set(key, next, 'persistent');
        return next;
      }

      throw ToolError.conflict({
        code: 'LOCK_HELD',
        message: `environment lock is held (key=${key}) until ${lock.expires_at}`,
        hint: 'Wait for the lock to expire, or cancel the conflicting operation before retrying.',
        details: { key, expires_at: lock.expires_at, holder_trace_id: lock.trace_id },
        retryable: true,
      });
    }

    const next = {
      ...(meta || {}),
      trace_id: traceId,
      acquired_at: nowIso,
      updated_at: nowIso,
      expires_at: expiresIso,
      ttl_ms: ttlMs,
      count: 1,
    };

    await this.stateService.set(key, next, 'persistent');
    return next;
  }

  async releaseLock({ key, traceId }) {
    if (!this.stateService) {
      return;
    }

    const nowIso = new Date().toISOString();
    const existing = await this.stateService.get(key, 'persistent');
    const lock = existing?.value;
    if (!lock || typeof lock !== 'object') {
      return;
    }

    if (!lock.trace_id || String(lock.trace_id) !== String(traceId)) {
      return;
    }

    const count = Math.max(1, Number(lock.count) || 1);
    if (count > 1) {
      await this.stateService.set(key, { ...lock, count: count - 1, updated_at: nowIso }, 'persistent');
      return;
    }

    await this.stateService.unset(key, 'persistent');
  }

  async guardGitOpsWrite({ intentType, inputs, traceId, projectName, targetName, repoRoot }) {
    const rawPolicy = this.resolvePolicy(inputs, null);
    if (!rawPolicy) {
      throw ToolError.denied({
        code: 'POLICY_REQUIRED',
        message: 'GitOps write intents require policy',
        hint: 'Provide inputs.policy (mode=operatorless) or configure target.policy.',
      });
    }
    const normalized = this.normalizePolicy(rawPolicy);
    this.assertGitOpsWriteAllowed({ intentType, inputs, policy: normalized, now: new Date() });

    const lockKey = normalized.lock.enabled
      ? this.buildLockKey({ projectName, targetName, repoRoot })
      : null;

    if (!lockKey && normalized.lock.enabled) {
      throw ToolError.invalidParams({
        message: 'policy.lock.enabled requires project/target or repo_root for lock scope',
        hint: 'Provide project+target (via workspace/project) or pass repo_root so the lock scope can be derived.',
      });
    }

    if (lockKey) {
      await this.acquireLock({
        key: lockKey,
        traceId,
        ttlMs: normalized.lock.ttl_ms,
        meta: {
          intent: intentType,
          project: projectName || undefined,
          target: targetName || undefined,
          repo_root: repoRoot || undefined,
        },
      });
    }

    return {
      policy: normalized,
      lock_key: lockKey,
      release: async () => {
        if (!lockKey) {
          return;
        }
        await this.releaseLock({ key: lockKey, traceId });
      },
    };
  }

  async guardRepoWrite({ action, inputs, traceId, projectContext, repoRoot }) {
    const rawPolicy = this.resolvePolicy(inputs, projectContext);
    if (!rawPolicy) {
      return null;
    }

    const normalized = this.normalizePolicy(rawPolicy);
    this.assertRepoWriteAllowed({ action, inputs, policy: normalized, now: new Date() });

    const lockKey = normalized.lock.enabled
      ? this.buildLockKey({
        projectName: projectContext?.projectName,
        targetName: projectContext?.targetName,
        repoRoot,
      })
      : null;

    if (!lockKey && normalized.lock.enabled) {
      throw ToolError.invalidParams({
        message: 'policy.lock.enabled requires project/target or repo_root for lock scope',
        hint: 'Provide project+target (via workspace/project) or pass repo_root so the lock scope can be derived.',
      });
    }

    if (lockKey) {
      await this.acquireLock({
        key: lockKey,
        traceId,
        ttlMs: normalized.lock.ttl_ms,
        meta: {
          action,
          project: projectContext?.projectName || undefined,
          target: projectContext?.targetName || undefined,
          repo_root: repoRoot || undefined,
        },
      });
    }

    return {
      policy: normalized,
      lock_key: lockKey,
      release: async () => {
        if (!lockKey) {
          return;
        }
        await this.releaseLock({ key: lockKey, traceId });
      },
    };
  }

  async guardKubectlWrite({ inputs, traceId, projectContext, repoRoot }) {
    const rawPolicy = this.resolvePolicy(inputs, projectContext);
    if (!rawPolicy) {
      return null;
    }

    const normalized = this.normalizePolicy(rawPolicy);
    this.assertKubectlWriteAllowed({ inputs, policy: normalized, now: new Date() });

    const lockKey = normalized.lock.enabled
      ? this.buildLockKey({
        projectName: projectContext?.projectName,
        targetName: projectContext?.targetName,
        repoRoot,
      })
      : null;

    if (!lockKey && normalized.lock.enabled) {
      throw ToolError.invalidParams({
        message: 'policy.lock.enabled requires project/target or repo_root for lock scope',
        hint: 'Provide project+target (via workspace/project) or pass repo_root so the lock scope can be derived.',
      });
    }

    if (lockKey) {
      await this.acquireLock({
        key: lockKey,
        traceId,
        ttlMs: normalized.lock.ttl_ms,
        meta: {
          action: 'kubectl',
          namespace: inputs?.namespace || undefined,
          project: projectContext?.projectName || undefined,
          target: projectContext?.targetName || undefined,
          repo_root: repoRoot || undefined,
        },
      });
    }

    return {
      policy: normalized,
      lock_key: lockKey,
      release: async () => {
        if (!lockKey) {
          return;
        }
        await this.releaseLock({ key: lockKey, traceId });
      },
    };
  }
}

module.exports = PolicyService;
