 [LEGEND]

[CONTENT]
# Architecture

SentryFrogg is a stdio-based MCP server built around a small service layer that wires managers to shared services.

## High-level structure

- `sentryfrogg_server.ts`
  - defines the MCP tool catalog (`tools/list`)
  - routes `call_tool` requests to manager handlers
  - writes logs to **stderr** to keep MCP stdout clean
- `src/bootstrap/ServiceBootstrap.ts`
  - builds the container and registers services
- Managers (tool implementations)
  - `src/managers/PostgreSQLManager.ts`
  - `src/managers/SSHManager.ts`
  - `src/managers/APIManager.ts`
  - `src/managers/StateManager.ts`
  - `src/managers/ProjectManager.ts`
  - `src/managers/ContextManager.ts`
  - `src/managers/CapabilityManager.ts`
  - `src/managers/IntentManager.ts`
  - `src/managers/EvidenceManager.ts`
  - `src/managers/WorkspaceManager.ts`
  - `src/managers/RunbookManager.ts`
  - `src/managers/AliasManager.ts`
  - `src/managers/PresetManager.ts`
  - `src/managers/AuditManager.ts`
  - `src/managers/PipelineManager.ts`
- Shared services
- `src/services/ProfileService.ts` — stores profiles and encrypted secrets
- `src/services/Security.ts` — encryption key lifecycle and crypto helpers
- `src/services/Validation.ts` — canonical input validation
- `src/services/Logger.ts` — minimal logger (stderr)
- `src/services/StateService.ts` — persistent/session state
- `src/services/ProjectService.ts` — project registry
- `src/services/ContextService.ts` — context detection
- `src/services/CapabilityService.ts` — capability registry
- `src/services/EvidenceService.ts` — evidence bundles
- `src/services/WorkspaceService.ts` — workspace summary/diagnostics
- `src/services/RunbookService.ts` — runbook storage
- `src/services/AliasService.ts` — alias storage
- `src/services/PresetService.ts` — preset storage
- `src/services/AuditService.ts` — audit log persistence
- `src/services/CacheService.ts` — file-backed cache
- `src/services/ToolExecutor.ts` — output shaping + `store_as` + trace metadata

## Profiles, storage, and encryption

Local state (base directory):
- Default: `${XDG_STATE_HOME}/sentryfrogg` or `~/.local/state/sentryfrogg`.

Bundles:
- Default `runbooks.json` / `capabilities.json` live in the repository and are safe to ship.
- Local overrides live in the base directory via `MCP_RUNBOOKS_PATH` / `MCP_CAPABILITIES_PATH`.

Store files:
- `profiles.json` — profile store (data + encrypted secrets)
- `.mcp_profiles.key` — persistent encryption key (created with `0600`)
- `state.json` — persistent state values (session state remains in memory)
- `projects.json` — project registry (targets → profile bindings)
- `context.json` — project context cache
- `capabilities.json` — capability registry
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
- `MCP_PROFILES_PATH` — explicit path to `profiles.json`
- `MCP_PROFILE_KEY_PATH` — explicit path to `.mcp_profiles.key`
- `MCP_STATE_PATH` — explicit path to `state.json`
- `MCP_PROJECTS_PATH` — explicit path to `projects.json`
- `MCP_RUNBOOKS_PATH` — explicit path to `runbooks.json`
- `MCP_DEFAULT_RUNBOOKS_PATH` — explicit path to default runbooks bundle
- `MCP_CAPABILITIES_PATH` — explicit path to `capabilities.json`
- `MCP_DEFAULT_CAPABILITIES_PATH` — explicit path to default capabilities bundle
- `MCP_ALIASES_PATH` — explicit path to `aliases.json`
- `MCP_PRESETS_PATH` — explicit path to `presets.json`
- `MCP_AUDIT_PATH` — explicit path to `audit.jsonl`
- `MCP_CACHE_DIR` — directory for cache files
- `ENCRYPTION_KEY` — supply a stable encryption key (recommended for shared environments)
- `LOG_LEVEL` — `error` / `warn` / `info` / `debug`
- `SENTRYFROGG_UNSAFE_LOCAL` / `SF_UNSAFE_LOCAL` — enable `mcp_local` (local exec + filesystem). Disabled by default.

## Operational model

- Managers accept either `profile_name` or inline connection data per request.
- PostgreSQL supports direct SQL, batches, transactions, and parameterized CRUD helpers.
- PostgreSQL also provides select/count/exists/export helpers for structured reads.
- SSH supports single commands, batches, basic diagnostics, and SFTP operations.
- HTTP supports profiles, typed bodies, auth providers, retry/backoff, pagination, and downloads.
- HTTP can optionally cache responses; pipelines provide streaming flows across HTTP, SFTP, and PostgreSQL.
- State is available for cross-tool workflows, runbooks orchestrate multi-step flows, and audit logs keep a traceable history.

This project is infrastructure-grade. Run it only in environments you trust.
