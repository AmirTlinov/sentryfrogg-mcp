 [LEGEND]

[CONTENT]
# MCP Configuration

SentryFrogg is a **stdio-based** Model Context Protocol (MCP) server. Your MCP client should spawn `node` and point it at `dist/sentryfrogg_server.js`.

See also:
- `docs/tools.md` (tool reference + examples)
- `docs/architecture.md` (architecture overview)

## Minimal client config (stdio)

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

Notes:
- Use an **absolute** path to avoid working-directory surprises.
- PostgreSQL and SSH can use `profile_*` actions or inline connection per request.

## Where profiles and keys are stored

By default, SentryFrogg stores local state in an OS-friendly location:
- `${XDG_STATE_HOME}/sentryfrogg` when `XDG_STATE_HOME` is set, otherwise
- `~/.local/state/sentryfrogg` (HOME fallback).

Store files:
- `profiles.json` (encrypted profile store)
- `.mcp_profiles.key` (persistent encryption key, created with `0600` permissions)
- `state.json` (persistent state store)
- `projects.json` (project registry)
- `context.json` (project context cache)
- `runbooks.json` (runbook definitions)
- `capabilities.json` (capability registry)
- `aliases.json` (alias registry)
- `presets.json` (preset registry)
- `audit.jsonl` (audit log)
- `cache/` (HTTP/pipeline cache)

Recommended environment variables:
- `MCP_PROFILES_DIR`: directory for `profiles.json` (keep it **outside** the repository)
- `MCP_PROFILES_PATH`: explicit path to `profiles.json`
- `MCP_PROFILE_KEY_PATH`: explicit path to `.mcp_profiles.key`
- `MCP_STATE_PATH`: explicit path to `state.json`
- `MCP_PROJECTS_PATH`: explicit path to `projects.json`
- `MCP_RUNBOOKS_PATH`: explicit path to `runbooks.json`
- `MCP_DEFAULT_RUNBOOKS_PATH`: explicit path to default runbooks bundle
- `MCP_CAPABILITIES_PATH`: explicit path to `capabilities.json`
- `MCP_DEFAULT_CAPABILITIES_PATH`: explicit path to default capabilities bundle
- `MCP_CONTEXT_PATH`: explicit path to `context.json`
- `MCP_ALIASES_PATH`: explicit path to `aliases.json`
- `MCP_PRESETS_PATH`: explicit path to `presets.json`
- `MCP_AUDIT_PATH`: explicit path to `audit.jsonl`
- `MCP_CACHE_DIR`: directory for cache files
- `ENCRYPTION_KEY`: provide a stable key (recommended for shared/team environments)
  - accepted formats: **64 hex chars** (32 bytes) / **32 raw chars** / base64 (decoded as bytes)
- `LOG_LEVEL`: server logging level (`error`, `warn`, `info`, `debug`); logs are written to **stderr** to keep MCP stdout clean

Important:
- Never commit local state (`profiles.json`, `state.json`, `projects.json`, `context.json`, `aliases.json`, `presets.json`, `audit.jsonl`, `cache/`, `.mcp_profiles.key`) to git.
- Default capability/runbook bundles are safe to ship in the repository; local overrides should live outside the repo via `MCP_RUNBOOKS_PATH` / `MCP_CAPABILITIES_PATH`.
- If these files were ever committed in history: rotate credentials, change `ENCRYPTION_KEY`, and purge git history (e.g., `git filter-repo` / BFG) before making the repository public.
- Profile format is **not** backward-compatible with pre-5.0 releases. Recreate profiles if upgrading.

## Tool bootstrap flow

1. Call `help` to discover tools and usage.
2. For PostgreSQL/SSH, optionally persist credentials with `profile_upsert`.
3. Run operational actions (`query`, `exec`, `request`, etc.).
4. Use `mcp_state` + `mcp_runbook` for multi-step workflows if needed.

### PostgreSQL example

```json
{
  "action": "profile_upsert",
  "profile_name": "default",
  "connection": {
    "host": "127.0.0.1",
    "port": 5432,
    "username": "user",
    "password": "pass",
    "database": "dbname",
    "ssl": false
  }
}
```

Then:

```json
{
  "action": "query",
  "profile_name": "default",
  "sql": "SELECT 1 AS ok"
}
```

### SSH example

```json
{
  "action": "profile_upsert",
  "profile_name": "default",
  "connection": {
    "host": "127.0.0.1",
    "port": 22,
    "username": "root",
    "password": "secret"
  }
}
```

Then:

```json
{
  "action": "exec",
  "profile_name": "default",
  "command": "uname -a"
}
```

### HTTP example

```json
{
  "action": "request",
  "method": "GET",
  "url": "https://example.com/health"
}
```

## Local integration targets

See `integration/README.md` for Docker-backed PostgreSQL/SSH targets and the `npm run smoke` script.
