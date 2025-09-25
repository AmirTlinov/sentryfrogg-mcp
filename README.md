# PSQL SSH API MCP Server v4.1.0

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-16%2B-green.svg)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-SDK-blue.svg)](https://github.com/modelcontextprotocol/sdk)

> English version | [Russian version](README_RU.md)

## Overview
The PSQL SSH API MCP Server is a lightweight service layer designed for Model Context Protocol (MCP) compatible agents that require controlled access to PostgreSQL databases, SSH targets and HTTP endpoints. The server provides a unified command surface, deterministic responses and production-grade safeguards suitable for enterprise and laboratory environments.

## Release Highlights (4.1.0)
- Consolidated bootstrap with three dedicated managers; dependency injection removed to improve transparency.
- Persistent AES-256 profile encryption with automatic key reuse and optional external key override.
- Consistent action payloads across PostgreSQL, SSH and HTTP managers for predictable automation.
- Detailed telemetry hooks (`getStats()`) to support monitoring and incident response workflows.
- Documentation and examples aligned with the current runtime and configuration defaults.

## Architecture
```
simple_openmcp_server.cjs      # MCP entry point
src/
├── bootstrap/ServiceBootstrap.cjs
├── managers/
│   ├── PostgreSQLManager.cjs
│   ├── SSHManager.cjs
│   └── APIManager.cjs
├── services/
│   ├── Logger.cjs
│   ├── Security.cjs
│   ├── Validation.cjs
│   └── ProfileService.cjs
├── constants/Constants.cjs
└── mcp_config.md              # Agent-facing cheatsheet
```
Each manager exposes a limited, audited surface area. Shared services handle logging, validation and secure profile storage.

## Prerequisites
- Node.js 16 or later with npm.
- Access to the target PostgreSQL instances, SSH hosts and HTTP endpoints.
- Permission to persist encrypted credentials on the host running the MCP server.

## Installation
```bash
git clone https://github.com/yourusername/psql-ssh-api.git
cd psql-ssh-api
npm install
```
Run a syntax check before attaching the server to an MCP client:
```bash
npm run check
```

## MCP Client Integration
Example Claude Desktop configuration (Windows path notation shown for clarity):
```json
{
  "mcpServers": {
    "psql-ssh-api": {
      "command": "node",
      "args": ["C:\\path\\to\\psql-ssh-api\\simple_openmcp_server.cjs"],
      "env": { "NODE_ENV": "production" }
    }
  }
}
```

## Security and Compliance
- Secrets are stored in `profiles.json` using AES-256-CBC. The encryption key is generated on first use and written to `.mcp_profiles.key` with `0600` permissions.
- Set `ENCRYPTION_KEY` to provide a managed key or to reuse profiles across hosts. Rotate the key using organisational key-management procedures.
- Input validation enforces required fields, command length limits and sequential execution for SSH actions to prevent race conditions.
- Review `.mcp_profiles.key` handling before committing or distributing repository snapshots to maintain compliance with local security policies.

## Manager Interfaces

### `mcp_psql_manager`
| Action | Purpose | Minimal payload |
| --- | --- | --- |
| `setup_profile` | Persist PostgreSQL credentials or a `connection_url` | `{ "action": "setup_profile", "host": "localhost", "username": "postgres", "password": "xxx", "database": "mydb" }` |
| `list_profiles` | Return stored profiles | `{ "action": "list_profiles" }` |
| `quick_query` | Execute SQL with optional parameters; enforces configurable limits | `{ "action": "quick_query", "sql": "SELECT * FROM users WHERE id = $1", "params": [1] }` |
| `show_tables` | List non-system tables for the active profile | `{ "action": "show_tables" }` |
| `describe_table` | Provide column metadata | `{ "action": "describe_table", "table_name": "users" }` |
| `sample_data` | Retrieve representative rows with a limit | `{ "action": "sample_data", "table_name": "users", "limit": 10 }` |
| `insert_data` | Insert JSON-formatted records | `{ "action": "insert_data", "table_name": "users", "data": { "name": "Ada" } }` |
| `update_data` | Update rows using a SQL `where` clause | `{ "action": "update_data", "table_name": "users", "data": { "active": true }, "where": "id = 1" }` |
| `delete_data` | Remove matching rows | `{ "action": "delete_data", "table_name": "users", "where": "id = 1" }` |
| `database_info` | Return basic database statistics | `{ "action": "database_info" }` |

### `mcp_ssh_manager`
| Action | Purpose | Minimal payload |
| --- | --- | --- |
| `setup_profile` | Store SSH host configuration (password or key based) | `{ "action": "setup_profile", "host": "example.com", "username": "root", "password": "xxx" }` |
| `list_profiles` | List configured SSH profiles | `{ "action": "list_profiles" }` |
| `execute` | Run shell commands sequentially | `{ "action": "execute", "command": "ls -la" }` |
| `system_info` | Collect key system facts | `{ "action": "system_info" }` |
| `check_host` | Perform a lightweight reachability probe | `{ "action": "check_host" }` |

### `mcp_api_client`
| Action | Purpose | Minimal payload |
| --- | --- | --- |
| `get` / `post` / `put` / `delete` / `patch` | Execute HTTP requests with JSON encoding | `{ "action": "get", "url": "https://api.example.com/users" }` |
| `check_api` | Perform a health check against an endpoint | `{ "action": "check_api", "url": "https://api.example.com/ping" }` |

Headers belong in the `headers` object; request bodies are provided via `data` and automatically serialised to JSON.

## Typical Workflow
```jsonc
// 1. Save a PostgreSQL profile using a connection URL
{ "action": "setup_profile", "connection_url": "postgres://postgres:postgres@localhost:5432/demo" }

// 2. Inspect tables
{ "action": "show_tables" }

// 3. Review data samples
{ "action": "sample_data", "table_name": "users", "limit": 5 }

// 4. Register an SSH profile with a private key
{ "action": "setup_profile", "profile_name": "prod", "host": "myserver.com", "username": "ubuntu", "private_key": "-----BEGIN...", "passphrase": "secret" }

// 5. Validate host reachability
{ "action": "check_host", "profile_name": "prod" }

// 6. Call an internal API endpoint
{ "action": "get", "url": "http://localhost:3000/status" }
```

## Operations
- `npm run check` validates the server entry point.
- Integration tests are executed through your MCP client by chaining profile setup and subsequent actions.
- Use the `getStats()` helper on each manager to gather utilisation metrics or to integrate with observability pipelines.

## Support and Contributions
1. Fork the repository and create a dedicated feature branch.
2. Implement the required change and include agent-facing usage examples.
3. Run `npm run check` before submitting.
4. Submit a pull request with a concise change summary and validation notes.

This project is published under the MIT License. All contributions must comply with the repository’s coding and security guidelines.
