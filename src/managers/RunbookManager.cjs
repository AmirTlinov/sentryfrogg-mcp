#!/usr/bin/env node

/**
 * 📚 Runbook manager.
 */

const crypto = require('crypto');
const { resolveTemplates, resolveTemplateString } = require('../utils/template.cjs');
const { getPathValue } = require('../utils/dataPath.cjs');
const { parseRunbookDsl } = require('../utils/runbookDsl.cjs');

const MAX_RETRY_ATTEMPTS = 50;
const MAX_RETRY_DELAY_MS = 60_000;
const MAX_RETRY_TOTAL_DELAY_MS = 10 * 60_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function asPositiveInt(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallback;
  }
  return Math.floor(numeric);
}

function asNonNegativeInt(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return fallback;
  }
  return Math.floor(numeric);
}

function asPositiveNumber(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallback;
  }
  return numeric;
}

class RunbookManager {
  constructor(logger, runbookService, stateService, toolExecutor) {
    this.logger = logger.child('runbook');
    this.runbookService = runbookService;
    this.stateService = stateService;
    this.toolExecutor = toolExecutor;
  }

  async handleAction(args = {}) {
    const { action } = args;

    switch (action) {
      case 'runbook_upsert':
        return this.runbookUpsert(args.name, args.runbook || args);
      case 'runbook_upsert_dsl':
        return this.runbookUpsert(args.name, this.runbookCompile(args.dsl || args.text || ''));
      case 'runbook_get':
        return this.runbookGet(args.name);
      case 'runbook_list':
        return this.runbookList();
      case 'runbook_delete':
        return this.runbookDelete(args.name);
      case 'runbook_run':
        return this.runbookRun(args);
      case 'runbook_run_dsl':
        return this.runbookRun({ ...args, runbook: this.runbookCompile(args.dsl || args.text || '') });
      case 'runbook_compile':
        return { success: true, runbook: this.runbookCompile(args.dsl || args.text || '') };
      default:
        throw new Error(`Unknown runbook action: ${action}`);
    }
  }

  async runbookUpsert(name, payload) {
    const runbook = payload.runbook || payload;
    return this.runbookService.setRunbook(name, runbook);
  }

  async runbookGet(name) {
    return this.runbookService.getRunbook(name);
  }

  async runbookList() {
    return this.runbookService.listRunbooks();
  }

  async runbookDelete(name) {
    return this.runbookService.deleteRunbook(name);
  }

  runbookCompile(dsl) {
    return parseRunbookDsl(dsl);
  }

  async runbookRun(args) {
    const input = args.input && typeof args.input === 'object' ? args.input : {};
    const stopOnError = args.stop_on_error !== false;
    const templateMissing = args.template_missing || 'error';
    const traceId = args.trace_id || crypto.randomUUID();
    const runbookSpanId = args.span_id || crypto.randomUUID();

    if (args.seed_state && typeof args.seed_state === 'object') {
      const scope = args.seed_state_scope || 'session';
      for (const [key, value] of Object.entries(args.seed_state)) {
        await this.stateService.set(key, value, scope);
      }
    }

    let runbookPayload;
    if (args.runbook) {
      runbookPayload = args.runbook;
    } else if (args.name) {
      const stored = await this.runbookService.getRunbook(args.name);
      runbookPayload = stored.runbook;
    } else {
      throw new Error('runbook_run requires name or runbook');
    }

    if (!Array.isArray(runbookPayload.steps) || runbookPayload.steps.length === 0) {
      throw new Error('runbook.steps must be a non-empty array');
    }

    const results = [];
    const context = await this.buildContext(input, {}, { traceId, spanId: runbookSpanId, parentSpanId: args.parent_span_id });

    for (let index = 0; index < runbookPayload.steps.length; index += 1) {
      const step = runbookPayload.steps[index];
      const stepKey = step.id || step.name || `step_${index + 1}`;

      try {
        const outcome = await this.executeStep(step, stepKey, context, {
          missing: templateMissing,
          traceId,
          parentSpanId: runbookSpanId,
        });
        results.push(outcome);
        context.steps[stepKey] = outcome.result;
      } catch (error) {
        const entry = {
          id: stepKey,
          tool: step.tool,
          action: step.args?.action,
          success: false,
          error: error.message,
        };
        results.push(entry);
        if (stopOnError && !step.continue_on_error) {
          return {
            success: false,
            runbook: args.name || runbookPayload.name,
            steps: results,
            error: error.message,
          };
        }
      }

      const refreshedState = await this.stateService.dump('any');
      context.state = refreshedState.state;
    }

    return {
      success: results.every((item) => item.success !== false),
      runbook: args.name || runbookPayload.name,
      steps: results,
      trace_id: traceId,
    };
  }

  async buildContext(input, steps, meta = {}) {
    const snapshot = await this.stateService.dump('any');
    return {
      input,
      state: snapshot.state,
      steps,
      trace_id: meta.traceId,
      span_id: meta.spanId,
      parent_span_id: meta.parentSpanId,
    };
  }

  evaluateWhen(condition, context, options) {
    if (condition === undefined || condition === null) {
      return true;
    }

    if (typeof condition === 'boolean') {
      return condition;
    }

    if (typeof condition === 'string') {
      const resolved = resolveTemplateString(condition, context, options);
      return !!resolved;
    }

    if (typeof condition !== 'object') {
      return false;
    }

    if (Array.isArray(condition.and)) {
      return condition.and.every((entry) => this.evaluateWhen(entry, context, options));
    }
    if (Array.isArray(condition.or)) {
      return condition.or.some((entry) => this.evaluateWhen(entry, context, options));
    }
    if (condition.not !== undefined) {
      return !this.evaluateWhen(condition.not, context, options);
    }

    const path = condition.path ? resolveTemplateString(condition.path, context, options) : undefined;
    const value = path ? getPathValue(context, path, { defaultValue: undefined }) : condition.value;

    if (condition.exists !== undefined) {
      return condition.exists ? value !== undefined : value === undefined;
    }

    if (condition.equals !== undefined) {
      const expected = resolveTemplates(condition.equals, context, options);
      return value === expected;
    }

    if (condition.not_equals !== undefined) {
      const expected = resolveTemplates(condition.not_equals, context, options);
      return value !== expected;
    }

    if (condition.in !== undefined) {
      const expected = resolveTemplates(condition.in, context, options);
      return Array.isArray(expected) ? expected.includes(value) : false;
    }

    if (condition.contains !== undefined) {
      const expected = resolveTemplates(condition.contains, context, options);
      if (typeof value === 'string') {
        return value.includes(String(expected));
      }
      if (Array.isArray(value)) {
        return value.includes(expected);
      }
      return false;
    }

    if (condition.gt !== undefined) {
      const expected = Number(resolveTemplates(condition.gt, context, options));
      return Number(value) > expected;
    }
    if (condition.gte !== undefined) {
      const expected = Number(resolveTemplates(condition.gte, context, options));
      return Number(value) >= expected;
    }
    if (condition.lt !== undefined) {
      const expected = Number(resolveTemplates(condition.lt, context, options));
      return Number(value) < expected;
    }
    if (condition.lte !== undefined) {
      const expected = Number(resolveTemplates(condition.lte, context, options));
      return Number(value) <= expected;
    }

    return !!value;
  }

  async executeStep(step, stepKey, context, options) {
    if (!step || typeof step !== 'object') {
      throw new Error('runbook step must be an object');
    }
    if (!step.tool) {
      throw new Error(`runbook step '${stepKey}' missing tool`);
    }

    if (step.tool === 'mcp_runbook') {
      throw new Error('Nested runbook execution is not supported');
    }

    const shouldRun = this.evaluateWhen(step.when, context, options);
    if (!shouldRun) {
      return { id: stepKey, tool: step.tool, action: step.args?.action, skipped: true, success: true };
    }

    const baseArgs = step.args || {};
    const resolvedArgs = step.foreach ? baseArgs : resolveTemplates(baseArgs, context, options);
    const retryConfig = step.retry ? resolveTemplates(step.retry, context, options) : null;
    const applyTrace = (args) => {
      const merged = { ...args };
      if (options?.traceId && merged.trace_id === undefined) {
        merged.trace_id = options.traceId;
      }
      if (options?.parentSpanId && merged.parent_span_id === undefined) {
        merged.parent_span_id = options.parentSpanId;
      }
      return merged;
    };

    if (step.foreach) {
      if (retryConfig) {
        throw new Error(`runbook step '${stepKey}' cannot combine foreach with retry`);
      }
      const foreachConfig = resolveTemplates(step.foreach, context, options);
      const items = foreachConfig.items;
      if (!Array.isArray(items)) {
        throw new Error(`runbook step '${stepKey}' foreach.items must be an array`);
      }

      const results = [];
      const parallel = foreachConfig.parallel === true;

      const runItem = async (item, index) => {
        const itemContext = {
          ...context,
          item,
          index,
        };
        const argsForItem = resolveTemplates(baseArgs, itemContext, options);
        return this.toolExecutor.execute(step.tool, applyTrace(argsForItem));
      };

      if (parallel) {
        const output = await Promise.all(items.map((item, index) => runItem(item, index)));
        output.forEach((entry) => results.push(entry.result));
      } else {
        for (let idx = 0; idx < items.length; idx += 1) {
          const entry = await runItem(items[idx], idx);
          results.push(entry.result);
        }
      }

      return {
        id: stepKey,
        tool: step.tool,
        action: resolvedArgs.action,
        success: true,
        result: results,
        foreach: { count: items.length },
      };
    }

    if (retryConfig && typeof retryConfig === 'object' && retryConfig.max_attempts !== undefined) {
      const maxAttempts = Math.min(
        asPositiveInt(retryConfig.max_attempts, 1),
        MAX_RETRY_ATTEMPTS
      );
      const delayMs = Math.min(
        asNonNegativeInt(retryConfig.delay_ms ?? retryConfig.base_delay_ms, 0),
        MAX_RETRY_DELAY_MS
      );
      const backoffFactor = asPositiveNumber(retryConfig.backoff_factor ?? retryConfig.backoff, 1);
      const maxDelayMs = retryConfig.max_delay_ms === undefined || retryConfig.max_delay_ms === null
        ? null
        : Math.min(asNonNegativeInt(retryConfig.max_delay_ms, delayMs), MAX_RETRY_DELAY_MS);
      const retryOnError = retryConfig.retry_on_error !== false;
      const until = retryConfig.until;

      const attempts = [];
      let totalDelayMs = 0;
      let lastError = null;

      for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex += 1) {
        const attempt = { index: attemptIndex, number: attemptIndex + 1, max_attempts: maxAttempts };
        const attemptContext = { ...context, attempt };

        try {
          const argsForAttempt = resolveTemplates(baseArgs, attemptContext, options);
          const output = await this.toolExecutor.execute(step.tool, applyTrace(argsForAttempt));
          attempts.push({ success: true, result: output.result });

          const untilContext = { ...attemptContext, result: output.result, meta: output.meta };
          const satisfied = until === undefined || until === null
            ? true
            : this.evaluateWhen(until, untilContext, options);

          if (satisfied) {
            return {
              id: stepKey,
              tool: step.tool,
              action: argsForAttempt.action,
              success: true,
              result: output.result,
              meta: output.meta,
              retry: { attempts: attemptIndex + 1 },
            };
          }

          lastError = new Error(`retry condition not satisfied (attempt ${attemptIndex + 1}/${maxAttempts})`);
        } catch (error) {
          lastError = error;
          attempts.push({ success: false, error: error.message });
          if (!retryOnError) {
            throw error;
          }
        }

        if (attemptIndex >= maxAttempts - 1) {
          break;
        }

        let nextDelay = delayMs;
        if (backoffFactor !== 1 && delayMs > 0) {
          nextDelay = Math.floor(delayMs * Math.pow(backoffFactor, attemptIndex));
        }
        if (maxDelayMs !== null) {
          nextDelay = Math.min(nextDelay, maxDelayMs);
        }
        if (nextDelay > 0) {
          if (totalDelayMs + nextDelay > MAX_RETRY_TOTAL_DELAY_MS) {
            throw new Error(`retry budget exceeded (${MAX_RETRY_TOTAL_DELAY_MS}ms)`);
          }
          totalDelayMs += nextDelay;
          await sleep(nextDelay);
        }
      }

      const message = lastError ? lastError.message : 'retry attempts exhausted';
      throw new Error(`Retry failed after ${maxAttempts} attempts: ${message}`);
    }

    const output = await this.toolExecutor.execute(step.tool, applyTrace(resolvedArgs));
    return {
      id: stepKey,
      tool: step.tool,
      action: resolvedArgs.action,
      success: true,
      result: output.result,
      meta: output.meta,
    };
  }

  getStats() {
    return this.runbookService.getStats();
  }

  async cleanup() {
    await this.runbookService.cleanup();
  }
}

module.exports = RunbookManager;
