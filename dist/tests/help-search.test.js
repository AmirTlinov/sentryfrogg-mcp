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
        clientInfo: { name: 'help-search-test', version: '1.0.0' },
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
(0, node_test_1.default)('help query finds ssh exec_follow action', async () => {
    const proc = (0, util_1.startServer)();
    try {
        proc.stdin.write(JSON.stringify(MCP_INIT) + '\n');
        JSON.parse(await (0, util_1.readLine)(proc.stdout));
        proc.stdin.write(JSON.stringify(callTool(2, 'help', { query: 'exec_follow', limit: 25 })) + '\n');
        const raw = parseToolText(JSON.parse(await (0, util_1.readLine)(proc.stdout)));
        const envelope = JSON.parse(raw);
        strict_1.default.equal(envelope.success, true);
        strict_1.default.ok(envelope.result);
        strict_1.default.equal(envelope.result.query, 'exec_follow');
        strict_1.default.ok(Array.isArray(envelope.result.results));
        strict_1.default.ok(envelope.result.results.some((item) => item.kind === 'action' && item.tool === 'mcp_ssh_manager' && item.action === 'exec_follow'));
    }
    finally {
        await (0, util_1.terminate)(proc);
    }
});
(0, node_test_1.default)('help query includes user aliases', async () => {
    const proc = (0, util_1.startServer)();
    try {
        proc.stdin.write(JSON.stringify(MCP_INIT) + '\n');
        JSON.parse(await (0, util_1.readLine)(proc.stdout));
        proc.stdin.write(JSON.stringify(callTool(2, 'mcp_alias', {
            action: 'alias_upsert',
            name: 'deploy',
            alias: {
                tool: 'ssh',
                args: { action: 'exec', target: 'prod', command: 'uname -a' },
                description: 'deploy shortcut',
            },
        })) + '\n');
        const upsert = JSON.parse(await (0, util_1.readLine)(proc.stdout));
        strict_1.default.equal(upsert.jsonrpc, '2.0');
        strict_1.default.ok(upsert.result);
        proc.stdin.write(JSON.stringify(callTool(3, 'help', { query: 'deploy', limit: 25 })) + '\n');
        const raw = parseToolText(JSON.parse(await (0, util_1.readLine)(proc.stdout)));
        const envelope = JSON.parse(raw);
        strict_1.default.equal(envelope.success, true);
        strict_1.default.ok(envelope.result);
        strict_1.default.equal(envelope.result.query, 'deploy');
        strict_1.default.ok(Array.isArray(envelope.result.results));
        strict_1.default.ok(envelope.result.results.some((item) => item.kind === 'alias' && item.alias === 'deploy' && item.tool));
    }
    finally {
        await (0, util_1.terminate)(proc);
    }
});
