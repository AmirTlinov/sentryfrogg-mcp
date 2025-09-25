# 🚀 COMPACT PostgreSQL + API + SSH MCP SERVER v4.1.0

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-16%2B-green.svg)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-SDK-blue.svg)](https://github.com/modelcontextprotocol/sdk)

> **English version | [Русская версия](README_RU.md)**

Built for AI agents: tiny surface area, predictable responses, no cognitive traps.

## 🎯 WHAT'S NEW IN 4.1.0

- ✅ **Ultra-light service layer** – one bootstrap + three managers, no hidden DI magic
- ✅ **Persistent profile secrets** – AES-256 key is generated once and reused automatically
- ✅ **Friendly tooling** – PostgreSQL, SSH and HTTP clients expose consistent `action` payloads
- ✅ **Agent-first ergonomics** – helpful errors, sequential SSH execution, JSON everywhere
- ✅ **Docs that match reality** – every example is copy/paste ready

## 🏗️ ARCHITECTURE SNAPSHOT
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
No legacy containers, no god-objects – just the pieces that matter.

## 🔧 INSTALLATION
```bash
git clone https://github.com/yourusername/psql-ssh-api.git
cd psql-ssh-api
npm install
npm run check
```

Add the server to Claude Desktop (Windows example):
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

## 🔐 PROFILES & SECURITY
- Passwords are encrypted with AES-256-CBC and stored in `profiles.json`
- Encryption key is kept in `.mcp_profiles.key` (auto-created with `0600` permissions)
- Set `ENCRYPTION_KEY` to override the key or share profiles between machines
- Data validation focuses on correctness and usability; no overzealous blocking

## 🛠️ TOOLS OVERVIEW

### `mcp_psql_manager`
| Action | Description | Minimal payload |
| --- | --- | --- |
| `setup_profile` | Save PostgreSQL credentials or `connection_url` | `{ "action": "setup_profile", "host": "localhost", "username": "postgres", "password": "xxx", "database": "mydb" }` |
| `list_profiles` | List saved PostgreSQL profiles | `{ "action": "list_profiles" }` |
| `quick_query` | Run SQL; auto-adds `LIMIT` if needed, supports params | `{ "action": "quick_query", "sql": "SELECT * FROM users WHERE id = $1", "params": [1] }` |
| `show_tables` | Show non-system tables | `{ "action": "show_tables" }` |
| `describe_table` | Column metadata | `{ "action": "describe_table", "table_name": "users" }` |
| `sample_data` | Grab rows with limit | `{ "action": "sample_data", "table_name": "users", "limit": 10 }` |
| `insert_data` | Insert JSON object | `{ "action": "insert_data", "table_name": "users", "data": { "name": "Ada" } }` |
| `update_data` | Update rows | `{ "action": "update_data", "table_name": "users", "data": { "active": true }, "where": "id = 1" }` |
| `delete_data` | Delete rows | `{ "action": "delete_data", "table_name": "users", "where": "id = 1" }` |
| `database_info` | Basic DB stats | `{ "action": "database_info" }` |

### `mcp_ssh_manager`
| Action | Description | Minimal payload |
| --- | --- | --- |
| `setup_profile` | Save SSH host (password or private_key) | `{ "action": "setup_profile", "host": "example.com", "username": "root", "password": "xxx" }` |
| `list_profiles` | List SSH targets | `{ "action": "list_profiles" }` |
| `execute` | Run shell command | `{ "action": "execute", "command": "ls -la" }` |
| `system_info` | Collect basic facts | `{ "action": "system_info" }` |
| `check_host` | Quick reachability ping | `{ "action": "check_host" }` |

Commands are trimmed, length-checked and executed sequentially per host to avoid race conditions, while still allowing pipes, redirects and multi-part commands.

### `mcp_api_client`
| Action | Description | Minimal payload |
| --- | --- | --- |
| `get`/`post`/`put`/`delete`/`patch` | Standard HTTP verbs | `{ "action": "get", "url": "https://api.example.com/users" }` |
| `check_api` | Lightweight health-check | `{ "action": "check_api", "url": "https://api.example.com/ping" }` |

Headers go under `headers`, request body under `data` (auto-JSON). Local and private URLs are allowed – ideal for internal tooling.

## ⚡ QUICK START WORKFLOW
```jsonc
// 1. Save DB profile via connection url
{ "action": "setup_profile", "connection_url": "postgres://postgres:postgres@localhost:5432/demo" }

// 2. Inspect tables
{ "action": "show_tables" }

// 3. Preview data
{ "action": "sample_data", "table_name": "users", "limit": 5 }

// 4. Save SSH profile with private key
{ "action": "setup_profile", "profile_name": "prod", "host": "myserver.com", "username": "ubuntu", "private_key": "-----BEGIN...", "passphrase": "secret" }

// 5. Check host health
{ "action": "check_host", "profile_name": "prod" }

// 6. Hit an internal API
{ "action": "get", "url": "http://localhost:3000/status" }
```

## 📊 STATS & CLEANUP
Every manager exposes a `getStats()` helper (used by `simple_openmcp_server.cjs`) so you can debug usage or surface telemetry if desired.

## 🧪 LOCAL CHECKS
- `npm run check` – syntax check entrypoint (`node --check`)
- Integration tests are CLI-based: run a profile setup + action from your MCP client of choice.

## 🤝 CONTRIBUTING
1. Fork the repository
2. Create a feature branch
3. Make your changes + add agent-facing examples
4. Run `npm run check`
5. Submit a PR

MIT licensed. Have fun building agent skills!
