#!/usr/bin/env node

/**
 * 🎯 Intent Manager (intent → plan → runbook)
 */

const SECRET_FIELD_PATTERN = /(key|token|secret|pass|pwd)/i;
const crypto = require('crypto');
const { matchesWhen } = require('../utils/whenMatcher.cjs');

const ToolError = require('../errors/ToolError.cjs');

function getByPath(source, path) {
  if (!path) {
    return undefined;
  }
  const parts = String(path).split('.').filter(Boolean);
  let current = source;
  for (const part of parts) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return undefined;
    }
    if (!Object.prototype.hasOwnProperty.call(current, part)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

function redactObject(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => redactObject(entry));
  }
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, entry] of Object.entries(value)) {
      if (SECRET_FIELD_PATTERN.test(key)) {
        result[key] = '***';
      } else {
        result[key] = redactObject(entry);
      }
    }
    return result;
  }
  return value;
}

function normalizeInputs(intentInputs, capability) {
  const inputs = intentInputs || {};
  const defaults = capability.inputs?.defaults || {};
  const map = capability.inputs?.map || {};
  const passThrough = capability.inputs?.pass_through !== false;
  const resolved = { ...defaults };

  for (const [target, source] of Object.entries(map)) {
    const value = getByPath(inputs, source);
    if (value !== undefined) {
      resolved[target] = value;
    }
  }

  if (passThrough) {
    for (const [key, value] of Object.entries(inputs)) {
      if (value !== undefined) {
        resolved[key] = value;
      }
    }
  }

  const required = capability.inputs?.required || [];
  const missing = required.filter((key) => resolved[key] === undefined || resolved[key] === null || resolved[key] === '');
  return { resolved, missing };
}

function aggregateEffects(steps) {
  let requiresApply = false;
  let kind = 'read';
  for (const step of steps) {
    const effect = step.effects || {};
    if (effect.requires_apply || effect.kind === 'write' || effect.kind === 'mixed') {
      requiresApply = true;
    }
    if (effect.kind === 'mixed') {
      kind = 'mixed';
    } else if (effect.kind === 'write' && kind !== 'mixed') {
      kind = 'write';
    }
  }
  return { kind, requires_apply: requiresApply };
}

class IntentManager {
  constructor(
    logger,
    security,
    validation,
    capabilityService,
    runbookManager,
    evidenceService,
    projectResolver,
    contextService,
    policyService
  ) {
    this.logger = logger.child('intent');
    this.security = security;
    this.validation = validation;
    this.capabilityService = capabilityService;
    this.runbookManager = runbookManager;
    this.evidenceService = evidenceService;
    this.projectResolver = projectResolver;
    this.contextService = contextService;
    this.policyService = policyService;
  }

  async handleAction(args = {}) {
    const { action } = args;
    switch (action) {
      case 'compile':
        return this.compile(args);
      case 'dry_run':
        return this.execute(args, { dryRun: true });
      case 'execute':
        return this.execute(args, { dryRun: false });
      case 'explain':
        return this.explain(args);
      default:
        throw ToolError.invalidParams({
          message: `Unknown intent action: ${action}`,
          field: 'action',
          hint: 'Use one of: compile, dry_run, execute, explain.',
        });
    }
  }

  async compile(args) {
    const { plan, missing } = await this.buildPlan(args, { allowMissing: true });
    return { success: true, plan, missing };
  }

  async explain(args) {
    const intent = await this.normalizeIntent(args);
    const capability = await this.resolveCapability(intent.type, intent.context || intent.inputs.context);
    const { resolved, missing } = normalizeInputs(intent.inputs, capability);
    return {
      success: true,
      intent: { type: intent.type, inputs: redactObject(intent.inputs) },
      capability,
      inputs: resolved,
      missing,
    };
  }

  async execute(args, { dryRun }) {
    const { plan, missing } = await this.buildPlan(args, { allowMissing: false });
    if (missing.length > 0) {
      throw ToolError.invalidParams({
        code: 'MISSING_INPUTS',
        message: `Missing required inputs: ${missing.join(', ')}`,
        hint: 'Provide the missing intent inputs and retry.',
        details: { missing },
      });
    }

    if (dryRun) {
      return {
        success: true,
        dry_run: true,
        plan,
        preview: plan.steps.map((step) => ({
          capability: step.capability,
          runbook: step.runbook,
          inputs: redactObject(step.inputs),
        })),
        missing,
      };
    }

    const traceId = args.trace_id || crypto.randomUUID();
    const apply = Boolean(args.apply || plan.intent.apply);
    if (plan.effects.requires_apply && !apply) {
      throw ToolError.denied({
        code: 'APPLY_REQUIRED',
        message: 'Intent requires apply=true for write/mixed effects',
        hint: 'Rerun with apply=true if you intend to perform write operations.',
      });
    }

    const isGitOpsWrite = apply
      && plan.effects.requires_apply
      && typeof plan.intent.type === 'string'
      && plan.intent.type.startsWith('gitops.');

    let policyGuard = null;
    if (isGitOpsWrite && this.policyService) {
      const repoRoot = args.repo_root || plan.intent.inputs?.repo_root || plan.intent.inputs?.context?.root;
      const projectName = plan.intent.project || plan.intent.inputs?.context?.project_name;
      const targetName = plan.intent.target || plan.intent.inputs?.context?.target_name;

      policyGuard = await this.policyService.guardGitOpsWrite({
        intentType: plan.intent.type,
        inputs: plan.intent.inputs,
        traceId,
        projectName,
        targetName,
        repoRoot,
      });
    } else if (isGitOpsWrite && !this.policyService) {
      throw ToolError.internal({
        code: 'POLICY_SERVICE_UNAVAILABLE',
        message: 'Policy service is not available for GitOps write intents',
        hint: 'This is a server configuration error. Enable PolicyService or disable GitOps write intents.',
      });
    }

    const stopOnError = args.stop_on_error !== false;
    const results = [];
    let success = true;

    try {
      for (const step of plan.steps) {
        const result = await this.runbookManager.handleAction({
          action: 'runbook_run',
          name: step.runbook,
          input: step.inputs,
          stop_on_error: stopOnError,
          template_missing: args.template_missing,
          trace_id: traceId,
          span_id: args.span_id,
          parent_span_id: args.parent_span_id,
        });
        results.push({
          capability: step.capability,
          runbook: step.runbook,
          result,
        });
        if (!result.success && stopOnError) {
          success = false;
          break;
        }
        if (!result.success) {
          success = false;
        }
      }
    } finally {
      if (policyGuard) {
        try {
          await policyGuard.release();
        } catch (error) {
          this.logger.warn('Failed to release policy lock', { error: error.message });
        }
      }
    }

    const evidence = {
      intent: redactObject(plan.intent),
      effects: plan.effects,
      dry_run: false,
      executed_at: new Date().toISOString(),
      steps: results,
      success,
    };

    let evidencePath;
    if (args.save_evidence) {
      const saved = await this.evidenceService.saveEvidence(evidence);
      evidencePath = saved.path;
    }

    return {
      success,
      dry_run: false,
      plan,
      results,
      evidence,
      evidence_path: evidencePath,
    };
  }

  async normalizeIntent(args) {
    const intent = this.validation.ensureObject(args.intent, 'Intent');
    const type = this.validation.ensureString(intent.type, 'Intent type');
    const inputs = { ...(this.validation.ensureOptionalObject(intent.inputs, 'Intent inputs') || {}) };
    const apply = Boolean(args.apply ?? intent.apply);
    let project = this.validation.ensureOptionalString(args.project ?? intent.project, 'Project');
    let target = this.validation.ensureOptionalString(args.target ?? intent.target, 'Target');
    let context = null;

    const resolveFromInputs = (value, label) => {
      if (value === undefined || value === null) {
        return undefined;
      }
      if (typeof value !== 'string') {
        return this.validation.ensureOptionalString(String(value), label);
      }
      const trimmed = value.trim();
      if (!trimmed) {
        return undefined;
      }
      return this.validation.ensureOptionalString(trimmed, label);
    };

    if (!project) {
      project = resolveFromInputs(inputs.project_name, 'Project') || project;
    }
    if (!target) {
      target = resolveFromInputs(inputs.target_name, 'Target') || target;
    }

    if (this.projectResolver) {
      context = await this.projectResolver.resolveContext({ ...args, project, target }).catch(() => null);
      if (!project && context?.projectName) {
        project = context.projectName;
      }
      if (!target && context?.targetName) {
        target = context.targetName;
      }
      if (context?.project && inputs.project === undefined) {
        inputs.project = context.project;
      }
      if (context?.target && inputs.target === undefined) {
        inputs.target = context.target;
      }
    }

    if (project && inputs.project_name === undefined) {
      inputs.project_name = project;
    }
    if (target && inputs.target_name === undefined) {
      inputs.target_name = target;
    }

    if (this.contextService && inputs.context === undefined) {
      const contextArgs = {
        project,
        target,
        cwd: args.cwd ?? intent.cwd,
        repo_root: args.repo_root ?? intent.repo_root,
        key: args.context_key,
        refresh: args.context_refresh === true,
      };
      const contextResult = await this.contextService.getContext(contextArgs).catch((error) => {
        this.logger.warn('Context resolution failed', { error: error.message });
        return null;
      });
      if (contextResult?.context) {
        inputs.context = contextResult.context;
        context = contextResult.context;
      }
    }

    return {
      type,
      inputs,
      apply,
      project,
      target,
      context,
    };
  }

  async resolveCapability(intentType, context) {
    const candidates = await this.capabilityService.findAllByIntent(intentType);
    if (!candidates || candidates.length === 0) {
      throw ToolError.notFound({
        code: 'CAPABILITY_NOT_FOUND',
        message: `Capability for intent '${intentType}' not found`,
        hint: 'Check capabilities.json (or configure capability mappings) and retry.',
        details: { intent_type: intentType },
      });
    }

    const resolvedContext = context && typeof context === 'object' ? context : {};
    const matched = [];
    for (const candidate of candidates) {
      if (await matchesWhen(candidate.when, resolvedContext)) {
        matched.push(candidate);
      }
    }

    if (matched.length === 0) {
      throw ToolError.notFound({
        code: 'CAPABILITY_NOT_MATCHED',
        message: `No capability matched when-clause for intent '${intentType}'`,
        hint: 'Provide the required context inputs (project/target/repo_root/etc) or adjust capability.when clauses.',
        details: { intent_type: intentType },
      });
    }

    matched.sort((a, b) => {
      const aIsDirect = a.name === intentType ? 0 : 1;
      const bIsDirect = b.name === intentType ? 0 : 1;
      if (aIsDirect !== bIsDirect) {
        return aIsDirect - bIsDirect;
      }
      return String(a.name).localeCompare(String(b.name));
    });

    return matched[0];
  }

  async buildPlan(args, { allowMissing }) {
    const intent = await this.normalizeIntent(args);
    const root = await this.resolveCapability(intent.type, intent.context || intent.inputs.context);
    const ordered = await this.resolveDependencies(root.name);
    const steps = [];
    const missing = [];

    for (const capability of ordered) {
      const { resolved, missing: missingInputs } = normalizeInputs(intent.inputs, capability);
      resolved.apply = intent.apply;
      steps.push({
        capability: capability.name,
        runbook: capability.runbook,
        inputs: resolved,
        effects: capability.effects,
      });
      if (missingInputs.length > 0) {
        missing.push(...missingInputs.map((key) => `${capability.name}.${key}`));
      }
    }

    if (!allowMissing && missing.length > 0) {
      throw ToolError.invalidParams({
        code: 'MISSING_INPUTS',
        message: `Missing required inputs: ${missing.join(', ')}`,
        hint: 'Provide the missing intent inputs and retry.',
        details: { missing },
      });
    }

    const plan = {
      intent,
      steps,
      effects: aggregateEffects(steps),
    };
    this.security.ensureSizeFits(JSON.stringify(plan));
    return { plan, missing };
  }

  async resolveDependencies(rootName) {
    const ordered = [];
    const visiting = new Set();
    const visited = new Set();

    const visit = async (name) => {
      if (visited.has(name)) {
        return;
      }
      if (visiting.has(name)) {
        throw ToolError.internal({
          code: 'CAPABILITY_DEP_CYCLE',
          message: `Capability dependency cycle at '${name}'`,
          hint: 'Fix capability.depends_on to remove cycles.',
          details: { capability: name },
        });
      }
      visiting.add(name);
      const capability = await this.capabilityService.getCapability(name);
      const deps = Array.isArray(capability.depends_on) ? capability.depends_on : [];
      for (const dep of deps) {
        await visit(dep);
      }
      visiting.delete(name);
      visited.add(name);
      ordered.push(capability);
    };

    await visit(rootName);
    return ordered;
  }
}

module.exports = IntentManager;
