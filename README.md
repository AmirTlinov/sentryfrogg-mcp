# SentryFrogg MCP Server

[Русская версия](README_RU.md) • [Docs](docs/README.md) • [MCP configuration](mcp_config.md) • [Integration stack](integration/README.md) • [Changelog](CHANGELOG.md)

![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![Node.js >=18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
[![CI](https://github.com/AmirTlinov/SentryFrogg-MCP/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/AmirTlinov/SentryFrogg-MCP/actions/workflows/ci.yml)

SentryFrogg is a stdio-based Model Context Protocol (MCP) server providing tools for PostgreSQL, SSH, and HTTP operations.

## Features
- PostgreSQL: parameterized queries, catalog helpers, optional client TLS
- SSH: per-profile sequential command execution
- HTTP: simple client with custom headers and bearer tokens
- Encrypted profile store (`profiles.json`) with persistent key (`.mcp_profiles.key`)
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
4. In your MCP client: call `help`, then `setup_profile` for PostgreSQL/SSH

## Tools
- `help`
- `mcp_psql_manager`
- `mcp_ssh_manager`
- `mcp_api_client`

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

