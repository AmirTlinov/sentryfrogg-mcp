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
        clientInfo: { name: 'did-you-mean-test', version: '1.0.0' },
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
(0, node_test_1.default)('help suggests closest tool name', async () => {
    const proc = (0, util_1.startServer)();
    try {
        proc.stdin.write(JSON.stringify(MCP_INIT) + '\n');
        JSON.parse(await (0, util_1.readLine)(proc.stdout));
        proc.stdin.write(JSON.stringify(callTool(2, 'help', { tool: 'psq' })) + '\n');
        const raw = parseToolText(JSON.parse(await (0, util_1.readLine)(proc.stdout)));
        const envelope = JSON.parse(raw);
        strict_1.default.equal(envelope.success, true);
        strict_1.default.ok(envelope.result);
        strict_1.default.ok(typeof envelope.result.error === 'string');
        strict_1.default.ok(Array.isArray(envelope.result.did_you_mean));
        strict_1.default.ok(envelope.result.did_you_mean.includes('psql'));
    }
    finally {
        await (0, util_1.terminate)(proc);
    }
});
(0, node_test_1.default)('help suggests closest action name', async () => {
    const proc = (0, util_1.startServer)();
    try {
        proc.stdin.write(JSON.stringify(MCP_INIT) + '\n');
        JSON.parse(await (0, util_1.readLine)(proc.stdout));
        proc.stdin.write(JSON.stringify(callTool(2, 'help', { tool: 'ssh', action: 'exec_folow' })) + '\n');
        const raw = parseToolText(JSON.parse(await (0, util_1.readLine)(proc.stdout)));
        const envelope = JSON.parse(raw);
        strict_1.default.equal(envelope.success, true);
        strict_1.default.ok(envelope.result);
        strict_1.default.ok(typeof envelope.result.error === 'string');
        strict_1.default.ok(Array.isArray(envelope.result.did_you_mean_actions));
        strict_1.default.ok(envelope.result.did_you_mean_actions.includes('exec_follow'));
    }
    finally {
        await (0, util_1.terminate)(proc);
    }
});
(0, node_test_1.default)('schema errors include did-you-mean for unknown fields', async () => {
    const proc = (0, util_1.startServer)();
    try {
        proc.stdin.write(JSON.stringify(MCP_INIT) + '\n');
        JSON.parse(await (0, util_1.readLine)(proc.stdout));
        proc.stdin.write(JSON.stringify(callTool(2, 'ssh', {
            action: 'exec',
            target: 'prod',
            commnd: 'uname -a',
        })) + '\n');
        const resp = JSON.parse(await (0, util_1.readLine)(proc.stdout));
        strict_1.default.equal(resp.jsonrpc, '2.0');
        strict_1.default.ok(resp.error);
        strict_1.default.equal(typeof resp.error.message, 'string');
        strict_1.default.ok(resp.error.message.includes("unknown field 'commnd'"));
        strict_1.default.ok(resp.error.message.includes('Did you mean'));
        strict_1.default.ok(resp.error.message.includes('command'));
        strict_1.default.ok(resp.error.message.includes("help({ tool: 'ssh', action: 'exec' })"));
    }
    finally {
        await (0, util_1.terminate)(proc);
    }
});
