"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// @ts-nocheck
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const util_1 = require("./util");
const MCP_INIT = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'artifacts-secret-export-test', version: '1.0.0' },
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
async function createTextArtifactUri(proc) {
    proc.stdin.write(JSON.stringify(callTool(2, 'mcp_state', {
        action: 'set',
        key: 'artifact_text',
        value: { ok: true },
        scope: 'session',
        trace_id: 'trace-artifacts',
        span_id: 'span-artifacts',
        response_mode: 'ai',
    })) + '\n');
    const raw = parseToolText(JSON.parse(await (0, util_1.readLine)(proc.stdout)));
    const envelope = JSON.parse(raw);
    strict_1.default.equal(envelope.tool, 'mcp_state');
    strict_1.default.equal(envelope.action, 'set');
    strict_1.default.ok(envelope.artifact_uri_json);
    return envelope.artifact_uri_json;
}
(0, node_test_1.default)('mcp_artifacts blocks base64 reads for text artifacts by default', async () => {
    const proc = (0, util_1.startServer)();
    try {
        proc.stdin.write(JSON.stringify(MCP_INIT) + '\n');
        JSON.parse(await (0, util_1.readLine)(proc.stdout));
        const uri = await createTextArtifactUri(proc);
        proc.stdin.write(JSON.stringify(callTool(3, 'mcp_artifacts', {
            action: 'get',
            uri,
            encoding: 'base64',
            max_bytes: 1024 * 16,
        })) + '\n');
        const resp = JSON.parse(await (0, util_1.readLine)(proc.stdout));
        strict_1.default.equal(resp.jsonrpc, '2.0');
        strict_1.default.ok(resp.error);
        strict_1.default.equal(typeof resp.error.message, 'string');
        strict_1.default.ok(resp.error.message.includes('code: ARTIFACT_BASE64_BLOCKED'));
    }
    finally {
        await (0, util_1.terminate)(proc);
    }
});
(0, node_test_1.default)('mcp_artifacts include_secrets requires explicit allow flag', async () => {
    const proc = (0, util_1.startServer)();
    try {
        proc.stdin.write(JSON.stringify(MCP_INIT) + '\n');
        JSON.parse(await (0, util_1.readLine)(proc.stdout));
        const uri = await createTextArtifactUri(proc);
        proc.stdin.write(JSON.stringify(callTool(3, 'mcp_artifacts', {
            action: 'get',
            uri,
            encoding: 'base64',
            include_secrets: true,
            max_bytes: 1024 * 16,
        })) + '\n');
        const resp = JSON.parse(await (0, util_1.readLine)(proc.stdout));
        strict_1.default.equal(resp.jsonrpc, '2.0');
        strict_1.default.ok(resp.error);
        strict_1.default.equal(typeof resp.error.message, 'string');
        strict_1.default.ok(resp.error.message.includes('code: SECRET_EXPORT_DISABLED'));
    }
    finally {
        await (0, util_1.terminate)(proc);
    }
});
(0, node_test_1.default)('mcp_artifacts include_secrets allows base64 when allow flag is set', async () => {
    const proc = (0, util_1.startServer)([], { SF_ALLOW_SECRET_EXPORT: '1' });
    try {
        proc.stdin.write(JSON.stringify(MCP_INIT) + '\n');
        JSON.parse(await (0, util_1.readLine)(proc.stdout));
        const uri = await createTextArtifactUri(proc);
        proc.stdin.write(JSON.stringify(callTool(3, 'mcp_artifacts', {
            action: 'get',
            uri,
            encoding: 'base64',
            include_secrets: true,
            max_bytes: 1024 * 16,
            trace_id: 'trace-artifacts-2',
            span_id: 'span-artifacts-2',
            response_mode: 'ai',
        })) + '\n');
        const raw = parseToolText(JSON.parse(await (0, util_1.readLine)(proc.stdout)));
        const envelope = JSON.parse(raw);
        strict_1.default.equal(envelope.tool, 'artifacts');
        strict_1.default.equal(envelope.action, 'get');
        strict_1.default.ok(envelope.result);
        strict_1.default.ok(typeof envelope.result.content_base64 === 'string');
        strict_1.default.ok(envelope.result.content_base64.length > 0);
    }
    finally {
        await (0, util_1.terminate)(proc);
    }
});
