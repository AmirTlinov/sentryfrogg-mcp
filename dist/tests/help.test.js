"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
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
        clientInfo: { name: 'help-test', version: '1.0.0' },
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
    assert.equal(resp.jsonrpc, '2.0');
    assert.ok(resp.result);
    assert.ok(Array.isArray(resp.result.content));
    return resp.result.content[0].text;
}
test('help returns actions for tools and supports tool/action drill-down', async () => {
    const proc = startServer();
    try {
        proc.stdin.write(JSON.stringify(MCP_INIT) + '\n');
        JSON.parse(await readLine(proc.stdout));
        proc.stdin.write(JSON.stringify(callTool(2, 'help', {})) + '\n');
        const root = JSON.parse(parseToolText(JSON.parse(await readLine(proc.stdout))));
        assert.equal(root.tool, 'help');
        assert.ok(root.result);
        assert.ok(typeof root.result.overview === 'string');
        assert.ok(Array.isArray(root.result.tools));
        assert.ok(root.result.tools.some((entry) => entry.name === 'mcp_ssh_manager'));
        assert.ok(root.result.tools.some((entry) => entry.name === 'legend'));
        proc.stdin.write(JSON.stringify(callTool(3, 'help', { tool: 'mcp_ssh_manager' })) + '\n');
        const sshHelp = JSON.parse(parseToolText(JSON.parse(await readLine(proc.stdout))));
        assert.equal(sshHelp.tool, 'help');
        assert.equal(sshHelp.result.name, 'mcp_ssh_manager');
        assert.ok(Array.isArray(sshHelp.result.actions));
        assert.ok(sshHelp.result.actions.includes('authorized_keys_add'));
        proc.stdin.write(JSON.stringify(callTool(4, 'help', { tool: 'ssh', action: 'exec' })) + '\n');
        const sshExec = JSON.parse(parseToolText(JSON.parse(await readLine(proc.stdout))));
        assert.equal(sshExec.tool, 'help');
        assert.equal(sshExec.result.name, 'mcp_ssh_manager');
        assert.equal(sshExec.result.action, 'exec');
        assert.ok(sshExec.result.example);
        assert.equal(sshExec.result.example.action, 'exec');
        assert.equal(sshExec.result.example.command, 'uname -a');
        proc.stdin.write(JSON.stringify(callTool(5, 'help', { tool: 'legend' })) + '\n');
        const helpLegend = JSON.parse(parseToolText(JSON.parse(await readLine(proc.stdout))));
        assert.equal(helpLegend.tool, 'help');
        assert.ok(helpLegend.result);
        assert.equal(helpLegend.result.name, 'legend');
        assert.ok(helpLegend.result.common_fields);
        assert.ok(helpLegend.result.common_fields.output);
        assert.ok(helpLegend.result.resolution);
        proc.stdin.write(JSON.stringify(callTool(6, 'legend', {})) + '\n');
        const legend = JSON.parse(parseToolText(JSON.parse(await readLine(proc.stdout))));
        assert.equal(legend.tool, 'legend');
        assert.ok(legend.result);
        assert.equal(legend.result.name, 'legend');
        assert.ok(Array.isArray(legend.result.golden_path));
        assert.ok(legend.result.golden_path.length > 0);
    }
    finally {
        await terminate(proc);
    }
});
