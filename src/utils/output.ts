#!/usr/bin/env node
// @ts-nocheck

const { getPathValue } = require('./dataPath');

function resolveEmptyDefault(output) {
  if (output && typeof output === 'object') {
    if (output.map) {
      return [];
    }
    if (output.pick || output.omit) {
      return {};
    }
  }
  return {};
}

function resolveMissingDefault(output) {
  if (!output || typeof output !== 'object') {
    return undefined;
  }

  if (Object.prototype.hasOwnProperty.call(output, 'default')) {
    return output.default;
  }

  switch (output.missing) {
    case 'null':
      return null;
    case 'undefined':
      return undefined;
    case 'empty':
      return resolveEmptyDefault(output);
    case 'error':
    default:
      return undefined;
  }
}

function pickFields(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  const result = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(value, field)) {
      result[field] = value[field];
    }
  }
  return result;
}

function omitFields(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  const result = { ...value };
  for (const field of fields) {
    delete result[field];
  }
  return result;
}

function applyOutputTransform(value, output) {
  if (!output || typeof output !== 'object') {
    return value;
  }

  const missingMode = output.missing || 'error';
  const required = missingMode === 'error';
  const defaultValue = resolveMissingDefault(output);

  let current = value;
  if (output.path) {
    current = getPathValue(current, output.path, { required, defaultValue });
  }

  if (output.pick && Array.isArray(output.pick)) {
    current = pickFields(current, output.pick);
  }

  if (output.omit && Array.isArray(output.omit)) {
    current = omitFields(current, output.omit);
  }

  if (output.map) {
    if (!Array.isArray(current)) {
      if (required) {
        throw new Error('Output map expects an array result');
      }
      current = defaultValue;
    }

    if (Array.isArray(current)) {
      current = current.map((item) => applyOutputTransform(item, output.map));
    }
  }

  return current;
}

module.exports = {
  applyOutputTransform,
};
