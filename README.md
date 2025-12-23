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
- Observability with trace/span metadata and audit logs (redacted).
- Encrypted local profile store (AES-256-GCM).
- Safe-by-default local writes (no overwrite unless `overwrite: true`).

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
         "args": ["/absolute/path/to/sentryfrogg_server.cjs"]
       }
     }
   }
   ```

   More details: `mcp_config.md`.
3. Start: `npm start`
4. In your MCP client: call `help`, then `profile_upsert` for PostgreSQL/SSH

## Tools
- `help`
- `mcp_psql_manager`
- `mcp_ssh_manager`
- `mcp_api_client`
- `mcp_state`
- `mcp_runbook`
- `mcp_alias`
- `mcp_preset`
- `mcp_audit`
- `mcp_pipeline`

Short aliases are also available (`sql`, `psql`, `ssh`, `http`, `api`, `state`, `runbook`, `pipeline`).

Reference + examples: `docs/tools.md`.

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
