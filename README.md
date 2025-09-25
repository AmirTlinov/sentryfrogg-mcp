# SentryFrogg MCP Server v4.2.0

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-16%2B-green.svg)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-SDK-blue.svg)](https://github.com/modelcontextprotocol/sdk)

> English version | [Russian version](README_RU.md)

## Overview
SentryFrogg MCP Server provides an auditable bridge between Model Context Protocol (MCP) compatible agents and three controlled execution channels: PostgreSQL, SSH and HTTP. The service delivers deterministic responses, uniform tooling semantics and operational controls tailored for enterprise and research environments.

## Release Highlights (4.2.0)
- TLS for PostgreSQL now supports client certificates, dedicated CA bundles and hostname pinning.
- Single bootstrap with three scoped managers; dependency injection layers removed for transparency.
- Persistent AES-256 key management with optional external key override for profile portability.
- Normalised action payloads across PostgreSQL, SSH and HTTP surfaces to simplify automation.
- Telemetry hooks (`getStats()`) for service diagnostics and observability integration.

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
└── mcp_config.md              # Agent reference sheet
```
Each manager offers a tightly scoped interface; shared services provide logging, validation and encrypted profile storage.

## Prerequisites
- Node.js 16 or later (npm included).
- Credentials for the target PostgreSQL instances, SSH hosts and HTTP endpoints.
- Permission to persist encrypted credentials on the system hosting SentryFrogg.

## Installation
```bash
git clone https://github.com/yourusername/sentryfrogg-mcp.git
cd sentryfrogg-mcp
npm install
```
Run a syntax check before attaching the server to an MCP client:
```bash
npm run check
```

## MCP Client Integration
Claude Desktop example (Windows paths shown for clarity):
```json
{
  "mcpServers": {
    "sentryfrogg": {
      "command": "node",
      "args": ["C:\\path\\to\\sentryfrogg-mcp\\simple_openmcp_server.cjs"],
      "env": { "NODE_ENV": "production" }
    }
  }
}
```

## Security and Compliance
- Secrets stored in `profiles.json` are encrypted with AES-256-CBC. The generated key resides in `.mcp_profiles.key` with `0600` permissions.
- Define `ENCRYPTION_KEY` to supply a managed key or to re-use profiles across hosts. Rotate keys using your standard key-management workflow.
- Client TLS assets (`ssl_ca`, `ssl_cert`, `ssl_key`, `ssl_passphrase`) are stored alongside passwords and encrypted by the same key hierarchy.
- Input validation enforces required fields, command length limits and sequential SSH execution to prevent race conditions.
- Review handling of `.mcp_profiles.key` before committing or distributing repository snapshots to maintain compliance obligations.

## Manager Interfaces

### `mcp_psql_manager`
| Action | Purpose | Minimal payload |
| --- | --- | --- |
| `setup_profile` | Persist PostgreSQL credentials or `connection_url` | `{ "action": "setup_profile", "host": "localhost", "username": "postgres", "password": "xxx", "database": "mydb" }` |
| `list_profiles` | Return stored profiles | `{ "action": "list_profiles" }` |
| `quick_query` | Execute SQL with optional parameters; enforces automatic limits | `{ "action": "quick_query", "sql": "SELECT * FROM users WHERE id = $1", "params": [1] }` |
| `show_tables` | List non-system tables | `{ "action": "show_tables" }` |
| `describe_table` | Provide column metadata | `{ "action": "describe_table", "table_name": "users" }` |
| `sample_data` | Retrieve representative rows with a limit | `{ "action": "sample_data", "table_name": "users", "limit": 10 }` |
| `insert_data` | Insert JSON-formatted records | `{ "action": "insert_data", "table_name": "users", "data": { "name": "Ada" } }` |
| `update_data` | Update rows using a SQL `where` clause | `{ "action": "update_data", "table_name": "users", "data": { "active": true }, "where": "id = 1" }` |
| `delete_data` | Remove matching rows | `{ "action": "delete_data", "table_name": "users", "where": "id = 1" }` |
| `database_info` | Return basic database statistics | `{ "action": "database_info" }` |

**TLS options** — add these fields to `setup_profile` when the target requires mutual TLS:

```jsonc
{
  "action": "setup_profile",
  "profile_name": "prod",
  "connection_url": "postgres://postgres@db.internal:5432/core?sslmode=verify-full",
  "ssl_ca": "-----BEGIN CERTIFICATE-----...",
  "ssl_cert": "-----BEGIN CERTIFICATE-----...",
  "ssl_key": "-----BEGIN PRIVATE KEY-----...",
  "ssl_passphrase": "optional",
  "ssl_servername": "db.internal",
  "ssl_reject_unauthorized": true
}
```

Certificates and private keys are encrypted at rest in `profiles.json`. Use `ssl_mode` (`disable`, `require`, `verify-ca`, `verify-full`) to map to PostgreSQL expectations when not provided via `connection_url`.

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
| `check_api` | Perform a health check | `{ "action": "check_api", "url": "https://api.example.com/ping" }` |

Headers belong in the `headers` object; request bodies are supplied via `data` and serialised to JSON.

## Typical Workflow
```jsonc
// 1. Register a PostgreSQL profile via connection URL
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
- `npm run check` validates the entry point.
- Integration validation occurs through MCP clients by chaining profile configuration and tool execution.
- Use `getStats()` on each manager to surface utilisation metrics or integrate with telemetry pipelines.

## Support and Contributions
1. Fork the repository and create a dedicated feature branch.
2. Implement the required change and include agent-facing usage examples.
3. Run `npm run check` before submission.
4. Submit a pull request summarising changes and validation steps.

The project is distributed under the MIT License. Contributions must follow the repository coding and security guidelines.
