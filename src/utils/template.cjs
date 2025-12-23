#!/usr/bin/env node

const { getPathValue } = require('./dataPath.cjs');

function normalizeExpression(expression) {
  const trimmed = String(expression || '').trim();
  if (!trimmed) {
    return { path: '', optional: false };
  }
  if (trimmed.startsWith('?')) {
    return { path: trimmed.slice(1).trim(), optional: true };
  }
  return { path: trimmed, optional: false };
}

function resolveExpression(expression, context, { missing = 'error' } = {}) {
  const { path, optional } = normalizeExpression(expression);
  if (!path) {
    return { value: '', found: false };
  }

  try {
    const value = getPathValue(context, path, { required: true });
    return { value, found: true };
  } catch (error) {
    if (optional || missing === 'empty') {
      return { value: '', found: false };
    }
    if (missing === 'null') {
      return { value: null, found: false };
    }
    if (missing === 'undefined') {
      return { value: undefined, found: false };
    }
    throw error;
  }
}

function stringifyResolved(value) {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}

function resolveTemplateString(template, context, options = {}) {
  const raw = String(template);
  const tokenRegex = /{{\s*([^}]+)\s*}}/g;
  const exactMatch = raw.match(/^{{\s*([^}]+)\s*}}$/);

  if (exactMatch) {
    const { value } = resolveExpression(exactMatch[1], context, options);
    return value;
  }

  return raw.replace(tokenRegex, (_, expr) => {
    const { value } = resolveExpression(expr, context, options);
    return stringifyResolved(value);
  });
}

function resolveTemplates(value, context, options = {}) {
  if (Array.isArray(value)) {
    return value.map((item) => resolveTemplates(item, context, options));
  }

  if (value && typeof value === 'object') {
    const resolved = {};
    for (const [key, entry] of Object.entries(value)) {
      resolved[key] = resolveTemplates(entry, context, options);
    }
    return resolved;
  }

  if (typeof value === 'string') {
    return resolveTemplateString(value, context, options);
  }

  return value;
}

module.exports = {
  resolveTemplates,
  resolveTemplateString,
};
