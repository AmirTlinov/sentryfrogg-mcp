"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// @ts-nocheck
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const promises_1 = __importDefault(require("node:fs/promises"));
const node_path_1 = __importDefault(require("node:path"));
const util_1 = require("./util");
const MCP_INIT = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'dx-mode-test', version: '1.0.0' },
    },
};
function callTool(id, name, args) {
    return {
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name, arguments: args },
    };
}
function parseToolText(resp) {
    strict_1.default.equal(resp.jsonrpc, '2.0');
    strict_1.default.ok(resp.result);
    strict_1.default.ok(Array.isArray(resp.result.content));
    strict_1.default.equal(resp.result.content[0].type, 'text');
    return resp.result.content[0].text;
}
(0, node_test_1.default)('response_mode=ai returns strict JSON and writes result.json artifact', async () => {
    const proc = (0, util_1.startServer)();
    try {
        proc.stdin.write(JSON.stringify(MCP_INIT) + '\n');
        JSON.parse(await (0, util_1.readLine)(proc.stdout));
        const traceId = 'trace-dx';
        const spanId = 'span-dx';
        proc.stdin.write(JSON.stringify(callTool(2, 'mcp_state', {
            action: 'set',
            key: 'dx_mode_test',
            value: { ok: true },
            scope: 'session',
            trace_id: traceId,
            span_id: spanId,
            response_mode: 'ai',
        })) + '\n');
        const raw = parseToolText(JSON.parse(await (0, util_1.readLine)(proc.stdout)));
        strict_1.default.ok(!raw.includes('[CONTENT]'));
        const envelope = JSON.parse(raw);
        strict_1.default.equal(envelope.tool, 'mcp_state');
        strict_1.default.equal(envelope.action, 'set');
        strict_1.default.ok(envelope.artifact_uri_json);
        strict_1.default.ok(envelope.artifact_uri_json.endsWith('/result.json'));
        strict_1.default.equal(envelope.trace.trace_id, traceId);
        strict_1.default.equal(envelope.trace.span_id, spanId);
        const root = proc.__sentryfrogg_profiles_dir;
        const artifactPath = node_path_1.default.join(root, 'artifacts', 'runs', traceId, 'tool_calls', spanId, 'result.json');
        const artifactText = await promises_1.default.readFile(artifactPath, 'utf8');
        const artifactJson = JSON.parse(artifactText);
        strict_1.default.equal(artifactJson.tool, 'mcp_state');
        strict_1.default.equal(artifactJson.action, 'set');
        strict_1.default.equal(artifactJson.artifact_uri_json, envelope.artifact_uri_json);
        proc.stdin.write(JSON.stringify(callTool(3, 'mcp_artifacts', {
            action: 'get',
            uri: envelope.artifact_uri_json,
            max_bytes: 1024 * 16,
            encoding: 'utf8',
            trace_id: 'trace-dx-2',
            span_id: 'span-dx-2',
            response_mode: 'ai',
        })) + '\n');
        const rawGet = parseToolText(JSON.parse(await (0, util_1.readLine)(proc.stdout)));
        const getEnvelope = JSON.parse(rawGet);
        strict_1.default.equal(getEnvelope.tool, 'artifacts');
        strict_1.default.equal(getEnvelope.action, 'get');
        strict_1.default.ok(getEnvelope.result);
        strict_1.default.ok(typeof getEnvelope.result.content === 'string');
        const parsedInner = JSON.parse(getEnvelope.result.content);
        strict_1.default.equal(parsedInner.tool, 'mcp_state');
        strict_1.default.equal(parsedInner.action, 'set');
    }
    finally {
        await (0, util_1.terminate)(proc);
    }
});
