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
        clientInfo: { name: 'arg-aliases-test', version: '1.0.0' },
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
(0, node_test_1.default)('arg aliases: cmd/argv/timeout are normalized for repo.exec (and reported)', async () => {
    const repoRoot = await promises_1.default.mkdtemp(node_path_1.default.join(node_os_1.default.tmpdir(), 'sf-alias-repo-'));
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
            proc.stdin.write(JSON.stringify(callTool(2, 'mcp_repo', {
                action: 'exec',
                repo_root: repoRoot,
                cmd: 'git',
                argv: ['rev-parse', '--is-inside-work-tree'],
                timeout: 10000,
                response_mode: 'ai',
            })) + '\n');
            const raw = parseToolText(JSON.parse(await (0, util_1.readLine)(proc.stdout)));
            const envelope = JSON.parse(raw);
            strict_1.default.equal(envelope.tool, 'repo');
            strict_1.default.equal(envelope.action, 'exec');
            strict_1.default.equal(envelope.exit_code, 0);
            strict_1.default.ok(String(envelope.stdout).includes('true'));
            strict_1.default.ok(envelope.normalization);
            strict_1.default.ok(Array.isArray(envelope.normalization.renamed));
            strict_1.default.ok(envelope.normalization.renamed.some((e) => e.from === 'cmd' && e.to === 'command'));
            strict_1.default.ok(envelope.normalization.renamed.some((e) => e.from === 'argv' && e.to === 'args'));
            strict_1.default.ok(envelope.normalization.renamed.some((e) => e.from === 'timeout' && e.to === 'timeout_ms'));
        }
        finally {
            await (0, util_1.terminate)(proc);
        }
    }
    finally {
        await promises_1.default.rm(repoRoot, { recursive: true, force: true });
    }
});
(0, node_test_1.default)('arg aliases: alias is ignored when canonical key is present (no silent overwrite)', async () => {
    const repoRoot = await promises_1.default.mkdtemp(node_path_1.default.join(node_os_1.default.tmpdir(), 'sf-alias-repo-2-'));
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
            proc.stdin.write(JSON.stringify(callTool(2, 'mcp_repo', {
                action: 'exec',
                repo_root: repoRoot,
                command: 'git',
                cmd: 'echo',
                args: ['rev-parse', '--is-inside-work-tree'],
                response_mode: 'ai',
            })) + '\n');
            const raw = parseToolText(JSON.parse(await (0, util_1.readLine)(proc.stdout)));
            const envelope = JSON.parse(raw);
            strict_1.default.equal(envelope.tool, 'repo');
            strict_1.default.equal(envelope.action, 'exec');
            strict_1.default.equal(envelope.exit_code, 0);
            strict_1.default.ok(envelope.normalization);
            strict_1.default.ok(Array.isArray(envelope.normalization.ignored));
            strict_1.default.ok(envelope.normalization.ignored.some((e) => e.from === 'cmd' && e.to === 'command' && e.reason === 'canonical_already_set'));
        }
        finally {
            await (0, util_1.terminate)(proc);
        }
    }
    finally {
        await promises_1.default.rm(repoRoot, { recursive: true, force: true });
    }
});
(0, node_test_1.default)('help supports q -> query alias', async () => {
    const proc = (0, util_1.startServer)();
    try {
        proc.stdin.write(JSON.stringify(MCP_INIT) + '\n');
        JSON.parse(await (0, util_1.readLine)(proc.stdout));
        proc.stdin.write(JSON.stringify(callTool(2, 'help', { q: 'exec_follow', limit: 25 })) + '\n');
        const raw = parseToolText(JSON.parse(await (0, util_1.readLine)(proc.stdout)));
        const envelope = JSON.parse(raw);
        strict_1.default.equal(envelope.success, true);
        strict_1.default.ok(envelope.result);
        strict_1.default.equal(envelope.result.query, 'exec_follow');
        strict_1.default.ok(Array.isArray(envelope.result.results));
        strict_1.default.ok(envelope.normalization);
        strict_1.default.ok(envelope.normalization.renamed.some((e) => e.from === 'q' && e.to === 'query'));
    }
    finally {
        await (0, util_1.terminate)(proc);
    }
});
