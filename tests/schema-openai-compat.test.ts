// @ts-nocheck
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, readLine, terminate } = require('./util');

const MCP_INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'schema-openai-compat-test', version: '1.0.0' },
  },
};

const MCP_LIST = {
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/list',
};

function validateOpenAICompatibleJsonSchema(schema, path = []) {
  const errors = [];

  function walk(node, nodePath) {
    if (node === null || node === undefined) {
      return;
    }
    if (typeof node !== 'object') {
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, idx) => walk(item, nodePath.concat(idx)));
      return;
    }

    if (Array.isArray(node.type)) {
      errors.push({
        kind: 'type-union-array',
        path: nodePath.concat('type').join('.'),
      });
    }

    if (node.type === 'array' && node.items === undefined) {
      errors.push({
        kind: 'array-missing-items',
        path: nodePath.join('.'),
      });
    }

    if (node.properties && typeof node.properties === 'object') {
      for (const [key, value] of Object.entries(node.properties)) {
        walk(value, nodePath.concat('properties', key));
      }
    }

    if (node.items !== undefined) {
      walk(node.items, nodePath.concat('items'));
    }

    if (node.additionalProperties && typeof node.additionalProperties === 'object') {
      walk(node.additionalProperties, nodePath.concat('additionalProperties'));
    }

    for (const keyword of ['anyOf', 'oneOf', 'allOf']) {
      if (Array.isArray(node[keyword])) {
        node[keyword].forEach((sub, idx) => walk(sub, nodePath.concat(keyword, idx)));
      }
    }
  }

  walk(schema, path);
  return errors;
}

test('tools/list schemas are OpenAI-compatible (no type unions; arrays have items)', async () => {
  const proc = startServer();
  try {
    proc.stdin.write(JSON.stringify(MCP_INIT) + '\n');
    JSON.parse(await readLine(proc.stdout));

    proc.stdin.write(JSON.stringify(MCP_LIST) + '\n');
    const listResp = JSON.parse(await readLine(proc.stdout));
    assert.equal(listResp.id, 2);
    assert.ok(Array.isArray(listResp.result.tools));

    const tools = listResp.result.tools;
    const allErrors = [];

    for (const tool of tools) {
      const schema = tool?.inputSchema;
      const errors = validateOpenAICompatibleJsonSchema(schema, ['tools', tool.name, 'inputSchema']);
      for (const err of errors) {
        allErrors.push({ tool: tool.name, ...err });
      }
    }

    assert.equal(
      allErrors.length,
      0,
      `Found ${allErrors.length} schema issues. First: ${JSON.stringify(allErrors[0])}`
    );
  } finally {
    await terminate(proc);
  }
});

