# Architecture

SentryFrogg is a stdio-based MCP server built around a small service layer that wires managers to shared services.

## High-level structure

- `sentryfrogg_server.cjs`
  - defines the MCP tool catalog (`tools/list`)
  - routes `call_tool` requests to manager handlers
  - writes logs to **stderr** to keep MCP stdout clean
- `src/bootstrap/ServiceBootstrap.cjs`
  - builds the container and registers services
- Managers (tool implementations)
  - `src/managers/PostgreSQLManager.cjs`
  - `src/managers/SSHManager.cjs`
  - `src/managers/APIManager.cjs`
  - `src/managers/StateManager.cjs`
  - `src/managers/RunbookManager.cjs`
  - `src/managers/AliasManager.cjs`
  - `src/managers/PresetManager.cjs`
  - `src/managers/AuditManager.cjs`
  - `src/managers/PipelineManager.cjs`
- Shared services
  - `src/services/ProfileService.cjs` — stores profiles and encrypted secrets
  - `src/services/Security.cjs` — encryption key lifecycle and crypto helpers
  - `src/services/Validation.cjs` — canonical input validation
  - `src/services/Logger.cjs` — minimal logger (stderr)
  - `src/services/StateService.cjs` — persistent/session state
  - `src/services/RunbookService.cjs` — runbook storage
  - `src/services/AliasService.cjs` — alias storage
  - `src/services/PresetService.cjs` — preset storage
  - `src/services/AuditService.cjs` — audit log persistence
  - `src/services/CacheService.cjs` — file-backed cache
  - `src/services/ToolExecutor.cjs` — output shaping + `store_as` + trace metadata

## Profiles, storage, and encryption

Local state:
- `profiles.json` — profile store (data + encrypted secrets)
- `.mcp_profiles.key` — persistent encryption key (created with `0600`)
- `state.json` — persistent state values (session state remains in memory)
- `runbooks.json` — runbook definitions
- `aliases.json` — alias registry
- `presets.json` — preset registry
- `audit.jsonl` — audit log
- `cache/` — HTTP/pipeline cache

Profile shape:

```json
{
  "name": {
    "type": "postgresql",
    "data": { "host": "db", "port": 5432, "username": "svc" },
    "secrets": { "password": "<encrypted>" },
    "created_at": "...",
    "updated_at": "..."
  }
}
```

Encryption:
- AES-256-GCM with an auto-generated key (or `ENCRYPTION_KEY`).
- Secrets are never returned in `profile_list` and only revealed via `profile_get` when explicitly requested.

Environment variables:
- `MCP_PROFILES_DIR` — directory for `profiles.json`
- `MCP_PROFILE_KEY_PATH` — explicit path to `.mcp_profiles.key`
- `MCP_STATE_PATH` — explicit path to `state.json`
- `MCP_RUNBOOKS_PATH` — explicit path to `runbooks.json`
- `MCP_ALIASES_PATH` — explicit path to `aliases.json`
- `MCP_PRESETS_PATH` — explicit path to `presets.json`
- `MCP_AUDIT_PATH` — explicit path to `audit.jsonl`
- `MCP_CACHE_DIR` — directory for cache files
- `ENCRYPTION_KEY` — supply a stable encryption key (recommended for shared environments)
- `LOG_LEVEL` — `error` / `warn` / `info` / `debug`

## Operational model

- Managers accept either `profile_name` or inline connection data per request.
- PostgreSQL supports direct SQL, batches, transactions, and parameterized CRUD helpers.
- PostgreSQL also provides select/count/exists/export helpers for structured reads.
- SSH supports single commands, batches, basic diagnostics, and SFTP operations.
- HTTP supports profiles, typed bodies, auth providers, retry/backoff, pagination, and downloads.
- HTTP can optionally cache responses; pipelines provide streaming flows across HTTP, SFTP, and PostgreSQL.
- State is available for cross-tool workflows, runbooks orchestrate multi-step flows, and audit logs keep a traceable history.

This project is infrastructure-grade. Run it only in environments you trust.
