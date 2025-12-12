# MCP Configuration

SentryFrogg is a **stdio-based** Model Context Protocol (MCP) server. Your MCP client should spawn `node` and point it at `sentryfrogg_server.cjs`.

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
- PostgreSQL and SSH require `setup_profile`. The HTTP client (`mcp_api_client`) is stateless.

## Where profiles and keys are stored

By default, SentryFrogg stores local state next to the entry file:
- `profiles.json` (encrypted profile store)
- `.mcp_profiles.key` (persistent encryption key, created with `0600` permissions)

Recommended environment variables:
- `MCP_PROFILES_DIR`: directory for `profiles.json` (keep it **outside** the repository)
- `MCP_PROFILE_KEY_PATH`: explicit path to `.mcp_profiles.key`
- `ENCRYPTION_KEY`: provide a stable key (recommended for shared/team environments)
  - accepted formats: **64 hex chars** (32 bytes) / **32 raw chars** / base64 (decoded as bytes)
- `LOG_LEVEL`: server logging level (`error`, `warn`, `info`, `debug`); logs are written to **stderr** to keep MCP stdout clean

Important:
- Never commit `profiles.json` or `.mcp_profiles.key` to git.
- If these files were ever committed in history: rotate credentials, change `ENCRYPTION_KEY`, and purge git history (e.g., `git filter-repo` / BFG) before making the repository public.

## Tool bootstrap flow

1. Call `help` to discover tools and usage.
2. For PostgreSQL/SSH, persist credentials with `setup_profile`.
3. Run operational actions (`quick_query`, `execute`, `get`, etc.).

### PostgreSQL example

```json
{
  "action": "setup_profile",
  "profile_name": "default",
  "connection_url": "postgresql://user:pass@127.0.0.1:5432/dbname"
}
```

Then:

```json
{
  "action": "quick_query",
  "profile_name": "default",
  "sql": "SELECT 1 AS ok"
}
```

### SSH example

```json
{
  "action": "setup_profile",
  "profile_name": "default",
  "host": "127.0.0.1",
  "port": 22,
  "username": "root",
  "password": "secret"
}
```

Then:

```json
{
  "action": "execute",
  "profile_name": "default",
  "command": "uname -a"
}
```

### HTTP example

```json
{
  "action": "get",
  "url": "https://example.com/health"
}
```

## Local integration targets

See `integration/README.md` for Docker-backed PostgreSQL/SSH targets and the `npm run smoke` script.
