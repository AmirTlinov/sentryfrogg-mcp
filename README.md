# SentryFrogg MCP Server

[Русская версия](README_RU.md) • [Docs](docs/README.md) • [MCP configuration](mcp_config.md) • [Integration stack](integration/README.md) • [Changelog](CHANGELOG.md)

![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![Node.js >=18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
[![CI](https://github.com/AmirTlinov/SentryFrogg-MCP/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/AmirTlinov/SentryFrogg-MCP/actions/workflows/ci.yml)

SentryFrogg is a stdio-based Model Context Protocol (MCP) server that offers PostgreSQL, SSH, HTTP, state, runbook, and pipeline tooling with a clean profile system.

## Features
- PostgreSQL: profiles or inline connections, query/batch/transaction, CRUD + select/count/exists/export
- SSH: exec/batch, diagnostics, SFTP (list/upload/download)
- HTTP: profiles, auth providers, retry/backoff, pagination, downloads, cache
- State + runbooks: session variables, multi-step workflows, DSL
- Aliases + presets: short names and reusable argument bundles
- Pipelines: streaming HTTP↔SFTP↔PostgreSQL flows
- Observability: trace/span metadata + audit log
- Output shaping + `store_as` for lightweight data pipelines
- Encrypted profile store (AES-256-GCM) with persistent key
- Logs to **stderr** (MCP JSON-RPC stays on **stdout**)

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
