# SentryFrogg MCP Server

[Русская версия](README_RU.md) • [Docs](docs/README.md) • [MCP configuration](mcp_config.md) • [Integration stack](integration/README.md) • [Changelog](CHANGELOG.md)

![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![Node.js >=18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
[![CI](https://github.com/AmirTlinov/sentryfrogg-mcp/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/AmirTlinov/sentryfrogg-mcp/actions/workflows/ci.yml)

SentryFrogg is a stdio-based Model Context Protocol (MCP) server that gives LLM agents a production-grade toolbox for PostgreSQL, SSH (incl. SFTP), and HTTP.
Use it when you want real infrastructure access without glue scripts: profiles, streaming pipelines, runbooks, and auditability are built in.

If you want your agent to move real data (API ↔ SFTP ↔ Postgres), run controlled SSH ops, and leave a traceable trail — this is the server.

## Why SentryFrogg
- One profile system across Postgres, SSH, and HTTP.
- Streaming pipelines between HTTP, SFTP, and Postgres for large payloads.
- Reliability primitives: retry/backoff, pagination, timeouts.
- Runbooks + state for multi-step workflows and repeatable ops.
- Intent layer with capability registry, previewed plans, and evidence bundles.
- Observability with trace/span metadata and audit logs (redacted).
- Encrypted local profile store (AES-256-GCM).
- Safe-by-default local writes (no overwrite unless `overwrite: true`).
- Optional unsafe local mode for full agent autonomy (local exec + filesystem).

## Agent-first DX (quality-of-life)
- `help({ query })` supports keyword search across tools/actions/fields/aliases.
- Typos get “did you mean” suggestions for tools, actions, and parameters.
- Errors are typed and actionable (usually include a `hint` + minimal working example).
- Safer defaults: secret redaction everywhere; “raw” secret export is opt-in and gated.
- Long-running exec/SSH flows prefer explicit status/progress over “detached silence”.

## Use cases
- Sync or backfill data between APIs, SFTP drops, and PostgreSQL.
- Run controlled remote operations via SSH with auditability.
- Build repeatable incident runbooks for agents and operators.

## Quick examples
Ingest JSONL into Postgres:

```json
{
  "action": "run",
  "flow": "http_to_postgres",
  "http": { "url": "https://example.com/events.jsonl" },
  "postgres": { "profile_name": "default", "table": "events" },
  "format": "jsonl",
  "batch_size": 500
}
```

Export Postgres to SFTP:

```json
{
  "action": "run",
  "flow": "postgres_to_sftp",
  "postgres": { "profile_name": "default", "table": "events" },
  "format": "csv",
  "sftp": { "profile_name": "default", "remote_path": "/tmp/events.csv", "overwrite": true }
}
```

## Quick start
1. Install: `npm install`
2. Configure your MCP client (stdio):

   ```json
   {
     "mcpServers": {
       "sentryfrogg": {
          "command": "node",
          "args": ["/absolute/path/to/dist/sentryfrogg_server.js"]
        }
      }
    }
   ```

   More details: `mcp_config.md`.
3. Start: `npm start`
4. In your MCP client: call `help` (try `help({ query: "ssh exec" })`), then `profile_upsert` for PostgreSQL/SSH

## Tools
- `help`
- `legend`
- `mcp_workspace`
- `mcp_jobs`
- `mcp_artifacts`
- `mcp_psql_manager`
- `mcp_ssh_manager`
- `mcp_api_client`
- `mcp_repo`
- `mcp_state`
- `mcp_runbook`
- `mcp_project`
- `mcp_context`
- `mcp_env`
- `mcp_vault`
- `mcp_capability`
- `mcp_intent`
- `mcp_evidence`
- `mcp_alias`
- `mcp_preset`
- `mcp_audit`
- `mcp_pipeline`
- `mcp_local` (unsafe, opt-in)

Short aliases are also available (e.g. `sql`/`psql`, `ssh`, `api`/`http`, `repo`, `job`, `artifacts`, `workspace`, `intent`, `pipeline`; plus `local` when unsafe mode is enabled).

Reference + examples: `docs/tools.md`.

## Intent UX
- Define capabilities in `capabilities.json` (override path via `MCP_CAPABILITIES_PATH`).
- Context snapshots are stored in `context.json` (override path via `MCP_CONTEXT_PATH`).
- `mcp_intent` compiles to a runbook plan, dry-run by default; write/mixed effects require `apply: true`.
- Evidence bundles are stored under `.sentryfrogg/evidence` (override path via `MCP_EVIDENCE_DIR`).

## Development
- `npm run check`
- `npm test`
- `npm run smoke` (Docker) — see `integration/README.md`

## Security
This server can execute SQL/SSH/HTTP by design. Run it only in environments you trust.

- Vulnerability reporting: `SECURITY.md`
- Public release checklist: `PUBLIC_RELEASE_CHECKLIST.md`

## License
MIT — see `LICENSE`.
