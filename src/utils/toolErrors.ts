#!/usr/bin/env node
// @ts-nocheck

const ToolError = require('../errors/ToolError');
const { suggest } = require('./suggest');

function normalizeString(value) {
  if (value === undefined || value === null) {
    return String(value);
  }
  if (typeof value === 'string') {
    return value;
  }
  return String(value);
}

function unknownActionError({ tool, action, knownActions, field = 'action' } = {}) {
  const safeTool = typeof tool === 'string' && tool.trim().length ? tool.trim() : 'tool';
  const actionValue = normalizeString(action);
  const known = Array.isArray(knownActions) ? knownActions.map(String) : [];
  const suggestions = actionValue ? suggest(actionValue, known, { limit: 5 }) : [];

  const shown = known.slice(0, 24);
  const suffix = known.length > shown.length ? ', ...' : '';
  const listHint = known.length > 0 ? `Use one of: ${shown.join(', ')}${suffix}.` : '';
  const didYouMeanHint = suggestions.length > 0 ? `Did you mean: ${suggestions.join(', ')}?` : '';
  const hint = [didYouMeanHint, listHint].filter(Boolean).join(' ');

  return ToolError.invalidParams({
    field,
    message: `Unknown ${safeTool} action: ${actionValue}`,
    hint: hint || undefined,
    details: known.length > 0 ? { known_actions: known, did_you_mean: suggestions } : undefined,
  });
}

module.exports = {
  unknownActionError,
};

