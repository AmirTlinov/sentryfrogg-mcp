# MCP Configuration

SentryFrogg is a **stdio-based** Model Context Protocol (MCP) server. Your MCP client should spawn `node` and point it at `sentryfrogg_server.cjs`.

See also:
- `docs/tools.md` (tool reference + examples)
- `docs/architecture.md` (architecture overview)

## Minimal client config (stdio)

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

Notes:
- Use an **absolute** path to avoid working-directory surprises.
- PostgreSQL and SSH can use `profile_*` actions or inline connection per request.

## Where profiles and keys are stored

By default, SentryFrogg stores local state next to the entry file:
- `profiles.json` (encrypted profile store)
- `.mcp_profiles.key` (persistent encryption key, created with `0600` permissions)
- `state.json` (persistent state store)
- `runbooks.json` (runbook definitions)
- `aliases.json` (alias registry)
- `presets.json` (preset registry)
- `audit.jsonl` (audit log)
- `cache/` (HTTP/pipeline cache)

Recommended environment variables:
- `MCP_PROFILES_DIR`: directory for `profiles.json` (keep it **outside** the repository)
- `MCP_PROFILE_KEY_PATH`: explicit path to `.mcp_profiles.key`
- `MCP_STATE_PATH`: explicit path to `state.json`
- `MCP_RUNBOOKS_PATH`: explicit path to `runbooks.json`
- `MCP_ALIASES_PATH`: explicit path to `aliases.json`
- `MCP_PRESETS_PATH`: explicit path to `presets.json`
- `MCP_AUDIT_PATH`: explicit path to `audit.jsonl`
- `MCP_CACHE_DIR`: directory for cache files
- `ENCRYPTION_KEY`: provide a stable key (recommended for shared/team environments)
  - accepted formats: **64 hex chars** (32 bytes) / **32 raw chars** / base64 (decoded as bytes)
- `LOG_LEVEL`: server logging level (`error`, `warn`, `info`, `debug`); logs are written to **stderr** to keep MCP stdout clean

Important:
- Never commit `profiles.json`, `state.json`, `runbooks.json`, `aliases.json`, `presets.json`, `audit.jsonl`, `cache/`, or `.mcp_profiles.key` to git.
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
