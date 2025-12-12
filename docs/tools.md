# Tool Reference

SentryFrogg exposes a small set of MCP tools over stdio.

Source of truth:
- `tools/list` returns the current tool schema (names, descriptions, JSON schemas).
- `help` provides a short overview from the server itself.

## `help`

Purpose: discover available tools and their intended usage.

Example:

```json
{ "tool": "mcp_psql_manager" }
```

## `mcp_psql_manager`

PostgreSQL toolchain. Typical flow:
1. `setup_profile`
2. execute an action using the same `profile_name`

Common actions:
- `setup_profile` — persist credentials/TLS materials
- `quick_query` — run SQL (with optional `params` for `$1`, `$2`, …)
- `show_tables` / `describe_table` / `sample_data` — catalog helpers
- `insert_data` / `update_data` / `delete_data` — CRUD helpers
- `database_info` — basic database info

Quick examples:

```json
{
  "action": "setup_profile",
  "profile_name": "default",
  "connection_url": "postgresql://user:pass@127.0.0.1:5432/dbname"
}
```

```json
{
  "action": "quick_query",
  "profile_name": "default",
  "sql": "SELECT $1::int AS ok",
  "params": [1]
}
```

TLS notes:
- SentryFrogg supports client TLS fields (`ssl_mode`, `ssl_ca`, `ssl_cert`, `ssl_key`, `ssl_passphrase`, `ssl_servername`, `ssl_reject_unauthorized`) during `setup_profile`.
- Keep PEM strings as `\\n`-escaped text in JSON.

## `mcp_ssh_manager`

SSH executor. Typical flow:
1. `setup_profile` (password or PEM `private_key`, optional `passphrase`)
2. operational actions (`execute`, `system_info`, `check_host`)

Example:

```json
{
  "action": "setup_profile",
  "profile_name": "default",
  "host": "127.0.0.1",
  "port": 22,
  "username": "mcp",
  "password": "mcp_pass"
}
```

```json
{
  "action": "execute",
  "profile_name": "default",
  "command": "uname -a"
}
```

## `mcp_api_client`

HTTP client for `get/post/put/delete/patch` plus `check_api`.

Example:

```json
{
  "action": "get",
  "url": "https://example.com/health"
}
```

Auth example:

```json
{
  "action": "get",
  "url": "https://example.com/private",
  "auth_token": "Bearer <token>"
}
```

Safety notes:
- URLs are validated for protocol and length, but the HTTP tool is still powerful; treat it as privileged.

