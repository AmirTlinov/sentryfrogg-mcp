#!/usr/bin/env node

const { mergeDeep, isPlainObject } = require('./merge.cjs');

function parseValue(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) {
    return '';
  }

  if (trimmed === 'true' || trimmed === 'false' || trimmed === 'null') {
    return JSON.parse(trimmed);
  }

  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }

  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch (error) {
      return trimmed;
    }
  }

  return trimmed;
}

function setPath(target, path, value) {
  const parts = path.split('.').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) {
    return;
  }
  let current = target;
  for (let idx = 0; idx < parts.length - 1; idx += 1) {
    const key = parts[idx];
    if (!isPlainObject(current[key])) {
      current[key] = {};
    }
    current = current[key];
  }
  current[parts[parts.length - 1]] = value;
}

function parseKeyValue(raw) {
  const trimmed = String(raw || '').trim();
  const eqIndex = trimmed.indexOf('=');
  if (eqIndex === -1) {
    throw new Error('arg directive requires key=value');
  }
  const key = trimmed.slice(0, eqIndex).trim();
  const valueRaw = trimmed.slice(eqIndex + 1).trim();
  if (!key) {
    throw new Error('arg directive requires key=value');
  }
  return { key, value: parseValue(valueRaw) };
}

function parseRunbookDsl(dsl) {
  const runbook = { steps: [] };
  const lines = String(dsl || '').split(/\r?\n/);
  let current = null;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const rawLine = lines[lineIndex];
    const trimmed = rawLine.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed.startsWith('#') || trimmed.startsWith('//')) {
      continue;
    }

    const spaceIndex = trimmed.indexOf(' ');
    const directive = spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex);
    const rest = spaceIndex === -1 ? '' : trimmed.slice(spaceIndex + 1).trim();

    switch (directive) {
      case 'runbook':
        runbook.name = rest;
        break;
      case 'description':
        runbook.description = rest;
        break;
      case 'step': {
        const tokens = rest.split(/\s+/).filter(Boolean);
        const id = tokens.shift();
        const tool = tokens.shift();
        const action = tokens.shift();
        if (!id || !tool) {
          throw new Error(`step requires id and tool at line ${lineIndex + 1}`);
        }
        const step = { id, tool, args: {} };
        if (action) {
          step.args.action = action;
        }
        if (tokens.length > 0) {
          const parsed = parseValue(tokens.join(' '));
          if (isPlainObject(parsed)) {
            step.args = mergeDeep(step.args, parsed);
          }
        }
        runbook.steps.push(step);
        current = step;
        break;
      }
      case 'tool':
        if (!current) {
          throw new Error(`tool directive before step at line ${lineIndex + 1}`);
        }
        current.tool = rest;
        break;
      case 'action':
        if (!current) {
          throw new Error(`action directive before step at line ${lineIndex + 1}`);
        }
        current.args = current.args || {};
        current.args.action = rest;
        break;
      case 'args': {
        if (!current) {
          throw new Error(`args directive before step at line ${lineIndex + 1}`);
        }
        const parsed = parseValue(rest);
        if (!isPlainObject(parsed)) {
          throw new Error(`args directive expects JSON object at line ${lineIndex + 1}`);
        }
        current.args = mergeDeep(current.args || {}, parsed);
        break;
      }
      case 'arg': {
        if (!current) {
          throw new Error(`arg directive before step at line ${lineIndex + 1}`);
        }
        const { key, value } = parseKeyValue(rest);
        current.args = current.args || {};
        setPath(current.args, key, value);
        break;
      }
      case 'when': {
        if (!current) {
          throw new Error(`when directive before step at line ${lineIndex + 1}`);
        }
        const parsed = parseValue(rest);
        current.when = parsed;
        break;
      }
      case 'foreach': {
        if (!current) {
          throw new Error(`foreach directive before step at line ${lineIndex + 1}`);
        }
        const parsed = parseValue(rest);
        current.foreach = parsed;
        break;
      }
      case 'continue_on_error': {
        if (!current) {
          throw new Error(`continue_on_error directive before step at line ${lineIndex + 1}`);
        }
        current.continue_on_error = parseValue(rest) === true;
        break;
      }
      default:
        throw new Error(`Unknown DSL directive '${directive}' at line ${lineIndex + 1}`);
    }
  }

  if (!Array.isArray(runbook.steps) || runbook.steps.length === 0) {
    throw new Error('runbook DSL must define at least one step');
  }

  return runbook;
}

module.exports = {
  parseRunbookDsl,
};
