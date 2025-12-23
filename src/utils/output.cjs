#!/usr/bin/env node

const { getPathValue } = require('./dataPath.cjs');

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
  const defaultValue = output.default;

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
    } else {
      current = current.map((item) => applyOutputTransform(item, output.map));
    }
  }

  return current;
}

module.exports = {
  applyOutputTransform,
};
