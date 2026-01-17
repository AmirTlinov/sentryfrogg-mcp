"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// @ts-nocheck
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const promises_1 = __importDefault(require("node:fs/promises"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const node_child_process_1 = require("node:child_process");
const util_1 = require("./util");
const MCP_INIT = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'dx-mode-exec-test', version: '1.0.0' },
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
(0, node_test_1.default)('repo.exec in ai-mode returns compact exec envelope (stdout without inline=true)', async () => {
    const repoRoot = await promises_1.default.mkdtemp(node_path_1.default.join(node_os_1.default.tmpdir(), 'sf-dx-repo-exec-'));
    try {
        (0, node_child_process_1.execFileSync)('git', ['init'], { cwd: repoRoot, stdio: 'ignore' });
        (0, node_child_process_1.execFileSync)('git', ['config', 'user.name', 'Test'], { cwd: repoRoot, stdio: 'ignore' });
        (0, node_child_process_1.execFileSync)('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot, stdio: 'ignore' });
        await promises_1.default.writeFile(node_path_1.default.join(repoRoot, 'note.txt'), 'hello\n', 'utf8');
        (0, node_child_process_1.execFileSync)('git', ['add', 'note.txt'], { cwd: repoRoot, stdio: 'ignore' });
        (0, node_child_process_1.execFileSync)('git', ['commit', '-m', 'init'], { cwd: repoRoot, stdio: 'ignore' });
        const proc = (0, util_1.startServer)();
        try {
            proc.stdin.write(JSON.stringify(MCP_INIT) + '\n');
            JSON.parse(await (0, util_1.readLine)(proc.stdout));
            const traceId = 'trace-repo-exec-dx';
            const spanId = 'span-repo-exec-dx';
            proc.stdin.write(JSON.stringify(callTool(2, 'mcp_repo', {
                action: 'exec',
                repo_root: repoRoot,
                command: 'git',
                args: ['rev-parse', '--is-inside-work-tree'],
                trace_id: traceId,
                span_id: spanId,
                response_mode: 'ai',
            })) + '\n');
            const raw = parseToolText(JSON.parse(await (0, util_1.readLine)(proc.stdout)));
            const envelope = JSON.parse(raw);
            strict_1.default.equal(envelope.tool, 'repo');
            strict_1.default.equal(envelope.action, 'exec');
            strict_1.default.equal(envelope.mode, 'sync');
            strict_1.default.equal(envelope.exit_code, 0);
            strict_1.default.equal(envelope.timed_out, false);
            strict_1.default.ok(typeof envelope.stdout === 'string');
            strict_1.default.ok(envelope.stdout.includes('true'));
            strict_1.default.equal(envelope.stdout_truncated, false);
            strict_1.default.ok(Array.isArray(envelope.next_actions));
            strict_1.default.equal(envelope.trace.trace_id, traceId);
            strict_1.default.equal(envelope.trace.span_id, spanId);
            strict_1.default.ok(envelope.artifact_uri_json);
            strict_1.default.ok(envelope.artifact_uri_json.endsWith('/result.json'));
        }
        finally {
            await (0, util_1.terminate)(proc);
        }
    }
    finally {
        await promises_1.default.rm(repoRoot, { recursive: true, force: true });
    }
});
(0, node_test_1.default)('local.exec in ai-mode returns compact exec envelope (stdout without inline=true)', async () => {
    const proc = (0, util_1.startServer)([], { SENTRYFROGG_UNSAFE_LOCAL: '1' });
    try {
        proc.stdin.write(JSON.stringify(MCP_INIT) + '\n');
        JSON.parse(await (0, util_1.readLine)(proc.stdout));
        const traceId = 'trace-local-exec-dx';
        const spanId = 'span-local-exec-dx';
        proc.stdin.write(JSON.stringify(callTool(2, 'mcp_local', {
            action: 'exec',
            command: process.execPath,
            args: ['-e', 'process.stdout.write("hello")'],
            trace_id: traceId,
            span_id: spanId,
            response_mode: 'ai',
        })) + '\n');
        const raw = parseToolText(JSON.parse(await (0, util_1.readLine)(proc.stdout)));
        const envelope = JSON.parse(raw);
        strict_1.default.equal(envelope.tool, 'local');
        strict_1.default.equal(envelope.action, 'exec');
        strict_1.default.equal(envelope.mode, 'sync');
        strict_1.default.equal(envelope.exit_code, 0);
        strict_1.default.equal(envelope.timed_out, false);
        strict_1.default.equal(envelope.stdout, 'hello');
        strict_1.default.equal(envelope.stdout_truncated, false);
        strict_1.default.ok(Array.isArray(envelope.next_actions));
        strict_1.default.equal(envelope.trace.trace_id, traceId);
        strict_1.default.equal(envelope.trace.span_id, spanId);
        strict_1.default.ok(envelope.artifact_uri_json);
        strict_1.default.ok(envelope.artifact_uri_json.endsWith('/result.json'));
    }
    finally {
        await (0, util_1.terminate)(proc);
    }
});
