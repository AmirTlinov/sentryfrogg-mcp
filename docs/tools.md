# Tool Reference

SentryFrogg exposes a small set of MCP tools over stdio.

Source of truth:
- `tools/list` returns the current tool schema (names, descriptions, JSON schemas).
- `help` provides a short overview from the server itself.

All managers accept either a stored `profile_name` or an inline `connection` object per call.
If only one profile exists for a tool, `profile_name` can be omitted.

Tool responses are wrapped in a consistent envelope:

```json
{
  "ok": true,
  "result": { "...": "..." },
  "meta": { "tool": "mcp_psql_manager", "action": "query", "trace_id": "...", "span_id": "...", "duration_ms": 12 }
}
```

## Global fields

All tools accept optional fields for output shaping and state capture:
- `output`: `{ path, pick, omit, map, missing, default }`
- `store_as`: string key or `{ key, scope }`
- `store_scope`: `session` | `persistent` (when `store_as` is a string)
- `trace_id`: propagate a trace identifier through logs and responses
- `span_id` / `parent_span_id`: span correlation for distributed traces
- `preset` / `preset_name`: apply a stored preset before merging call arguments

`store_as` defaults to `session` scope unless `store_scope` is provided.

Example:

```json
{
  "action": "query",
  "profile_name": "default",
  "sql": "SELECT id, status FROM orders",
  "output": { "path": "rows", "pick": ["id", "status"] },
  "store_as": "orders_snapshot",
  "store_scope": "session"
}
```

## `help`

Purpose: discover available tools and their intended usage.

Example:

```json
{ "tool": "mcp_psql_manager" }
```

## `mcp_state`

Session/persistent key-value store for cross-tool workflows.

Key actions:
- `set` / `get` / `list` / `unset` / `clear` / `dump`

Example:

```json
{
  "action": "set",
  "key": "token",
  "value": "abc123",
  "scope": "session"
}
```

## `mcp_runbook`

Runbooks store and execute multi-step workflows with templating, `when`, and `foreach`.

Key actions:
- `runbook_upsert` / `runbook_upsert_dsl` / `runbook_get` / `runbook_list` / `runbook_delete`
- `runbook_run` / `runbook_run_dsl`
- `runbook_compile` (DSL → JSON)

Runbook example:

```json
{
  "action": "runbook_upsert",
  "name": "fetch-orders",
  "runbook": {
    "steps": [
      {
        "id": "token",
        "tool": "mcp_api_client",
        "args": {
          "action": "request",
          "method": "POST",
          "url": "https://auth.example.com/token",
          "form": { "client_id": "svc", "client_secret": "{{input.secret}}" },
          "output": { "path": "data.access_token" },
          "store_as": "api_token",
          "store_scope": "session"
        }
      },
      {
        "id": "orders",
        "tool": "mcp_api_client",
        "args": {
          "action": "request",
          "method": "GET",
          "url": "https://api.example.com/orders",
          "auth": "{{state.api_token}}"
        }
      }
    ]
  }
}
```

Notes:
- Templates support `{{input.*}}`, `{{state.*}}`, `{{steps.<id>.*}}`, plus `{{item}}` inside `foreach`.
- `when` supports `path/equals/not_equals/in/contains` and boolean logic (`and`/`or`/`not`).

DSL example:

```text
runbook fetch-orders
step token mcp_api_client request
arg url=https://auth.example.com/token
arg form.client_id=svc
arg form.client_secret={{input.secret}}
step orders mcp_api_client request
arg url=https://api.example.com/orders
arg auth={{state.api_token}}
```

## `mcp_alias`

Aliases provide short names that resolve to a tool + optional args.

Key actions:
- `alias_upsert` / `alias_get` / `alias_list` / `alias_delete` / `alias_resolve`

Example:

```json
{
  "action": "alias_upsert",
  "name": "gh",
  "alias": {
    "tool": "mcp_api_client",
    "args": { "action": "request", "base_url": "https://api.github.com" }
  }
}
```

## `mcp_preset`

Presets store reusable argument bundles for any tool.

Key actions:
- `preset_upsert` / `preset_get` / `preset_list` / `preset_delete`

Example:

```json
{
  "action": "preset_upsert",
  "tool": "mcp_api_client",
  "name": "github",
  "preset": {
    "headers": { "Accept": "application/vnd.github+json" }
  }
}
```

## `mcp_psql_manager`

PostgreSQL toolchain with profiles, queries, transactions, and CRUD helpers.

Key actions:
- `profile_upsert` / `profile_get` / `profile_list` / `profile_delete` / `profile_test`
- `query` / `batch` / `transaction`
- `insert` / `insert_bulk` / `update` / `delete`
- `select` / `count` / `exists` / `export`
- `catalog_tables` / `catalog_columns` / `database_info`

Profile example:

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

Query example:

```json
{
  "action": "query",
  "profile_name": "default",
  "sql": "SELECT $1::int AS ok",
  "params": [1]
}
```

Transaction example:

```json
{
  "action": "transaction",
  "profile_name": "default",
  "statements": [
    { "sql": "UPDATE accounts SET balance = balance - $1 WHERE id = $2", "params": [100, 1] },
    { "sql": "UPDATE accounts SET balance = balance + $1 WHERE id = $2", "params": [100, 2] }
  ]
}
```

CRUD example:

```json
{
  "action": "update",
  "profile_name": "default",
  "table": "orders",
  "data": { "status": "paid" },
  "filters": { "id": 42 },
  "returning": true
}
```

Bulk insert example:

```json
{
  "action": "insert_bulk",
  "profile_name": "default",
  "table": "events",
  "rows": [
    { "name": "signup", "source": "web" },
    { "name": "purchase", "source": "api" }
  ]
}
```

Notes:
- `update`/`delete` without `filters` or `where_sql` will affect **all** rows in the table.

Select example:

```json
{
  "action": "select",
  "profile_name": "default",
  "table": "orders",
  "columns": ["id", "status"],
  "filters": { "status": "paid" },
  "order_by": { "column": "id", "direction": "DESC" },
  "limit": 25
}
```

Export example:

```json
{
  "action": "export",
  "profile_name": "default",
  "table": "orders",
  "format": "csv",
  "file_path": "/tmp/orders.csv",
  "overwrite": true,
  "batch_size": 1000
}
```

Note:
- `export` refuses to overwrite an existing `file_path` unless `overwrite: true`.

## `mcp_ssh_manager`

SSH executor with profiles, single exec, batch runs, and diagnostics.

Key actions:
- `profile_upsert` / `profile_get` / `profile_list` / `profile_delete` / `profile_test`
- `exec` / `batch` / `system_info` / `check_host`
- `sftp_list` / `sftp_upload` / `sftp_download`

Profile example:

```json
{
  "action": "profile_upsert",
  "profile_name": "default",
  "connection": {
    "host": "127.0.0.1",
    "port": 22,
    "username": "mcp",
    "password": "mcp_pass"
  }
}
```

Exec example:

```json
{
  "action": "exec",
  "profile_name": "default",
  "command": "uname -a"
}
```

Batch example:

```json
{
  "action": "batch",
  "profile_name": "default",
  "commands": [
    { "command": "whoami" },
    { "command": "uptime" }
  ]
}
```

SFTP upload example:

```json
{
  "action": "sftp_upload",
  "profile_name": "default",
  "local_path": "/tmp/report.csv",
  "remote_path": "/var/tmp/report.csv",
  "mkdirs": true
}
```

## `mcp_api_client`

HTTP client with profiles, flexible bodies, and response parsing.

Key actions:
- `profile_upsert` / `profile_get` / `profile_list` / `profile_delete`
- `request` / `paginate` / `download` / `check`

Profile example:

```json
{
  "action": "profile_upsert",
  "profile_name": "default",
  "base_url": "https://api.example.com",
  "auth": { "type": "bearer", "token": "<token>" }
}
```

Request example:

```json
{
  "action": "request",
  "profile_name": "default",
  "method": "GET",
  "path": "/v1/health"
}
```

Retry/backoff example:

```json
{
  "action": "request",
  "method": "GET",
  "url": "https://api.example.com/orders",
  "retry": { "max_attempts": 4, "base_delay_ms": 300 }
}
```

Cache example:

```json
{
  "action": "request",
  "method": "GET",
  "url": "https://api.example.com/orders",
  "cache": { "ttl_ms": 60000 }
}
```

Pagination example:

```json
{
  "action": "paginate",
  "method": "GET",
  "url": "https://api.example.com/orders",
  "pagination": {
    "type": "page",
    "param": "page",
    "size_param": "limit",
    "size": 50,
    "item_path": "data.items"
  }
}
```

Download example:

```json
{
  "action": "download",
  "method": "GET",
  "url": "https://example.com/report.csv",
  "download_path": "/tmp/report.csv",
  "overwrite": true
}
```

Note:
- `download` refuses to overwrite an existing `download_path` unless `overwrite: true`.

Auth provider (exec) example:

```json
{
  "action": "profile_upsert",
  "profile_name": "example",
  "base_url": "https://api.example.com",
  "auth_provider": {
    "type": "exec",
    "command": "security-token",
    "args": ["--json"],
    "format": "json",
    "token_path": "access_token"
  }
}
```

Safety notes:
- This tool can reach any HTTP endpoint. Treat it as privileged in production environments.

## `mcp_audit`

Audit log access for tool execution events.

Key actions:
- `audit_list` / `audit_tail` / `audit_stats` / `audit_clear`

Example:

```json
{
  "action": "audit_list",
  "trace_id": "<trace-id>",
  "limit": 50
}
```

## `mcp_pipeline`

Streaming pipelines between HTTP, SFTP, and PostgreSQL.

Key actions:
- `run` / `describe`

Available flows:
- `http_to_sftp`
- `sftp_to_http`
- `http_to_postgres`
- `sftp_to_postgres`
- `postgres_to_sftp`
- `postgres_to_http`

Postgres export options (for `postgres_*` flows): `format`, `batch_size`, `limit`, `offset`,
`columns`/`columns_sql`, `order_by`/`order_by_sql`, `filters`/`where_sql`/`where_params`,
`csv_header`, `csv_delimiter`, `timeout_ms`.

HTTP → Postgres example:

```json
{
  "action": "run",
  "flow": "http_to_postgres",
  "http": { "url": "https://example.com/data.jsonl" },
  "postgres": { "profile_name": "default", "table": "events" },
  "format": "jsonl",
  "batch_size": 500
}
```

HTTP → SFTP example:

```json
{
  "action": "run",
  "flow": "http_to_sftp",
  "http": { "url": "https://example.com/report.csv" },
  "sftp": { "profile_name": "default", "remote_path": "/tmp/report.csv", "mkdirs": true }
}
```

Postgres → SFTP example:

```json
{
  "action": "run",
  "flow": "postgres_to_sftp",
  "postgres": { "profile_name": "default", "table": "events" },
  "format": "csv",
  "order_by": ["id"],
  "sftp": { "profile_name": "default", "remote_path": "/tmp/events.csv", "overwrite": true }
}
```

Postgres → HTTP example:

```json
{
  "action": "run",
  "flow": "postgres_to_http",
  "postgres": { "profile_name": "default", "table": "events" },
  "format": "jsonl",
  "http": { "url": "https://example.com/ingest", "method": "POST" }
}
```
