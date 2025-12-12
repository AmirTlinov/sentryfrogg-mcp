# Architecture

SentryFrogg is a stdio-based MCP server built around a small “service layer” that wires together managers and shared services.

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
- Shared services
  - `src/services/ProfileService.cjs` — stores profiles and encrypted secrets
  - `src/services/Security.cjs` — encryption key lifecycle and crypto helpers
  - `src/services/Validation.cjs` — canonical input validation
  - `src/services/Logger.cjs` — minimal logger (stderr)

## Profiles, storage, and encryption

Local state:
- `profiles.json` — profile store (secrets encrypted)
- `.mcp_profiles.key` — persistent encryption key (created with `0600`)

Environment variables:
- `MCP_PROFILES_DIR` — directory for `profiles.json`
- `MCP_PROFILE_KEY_PATH` — explicit path to `.mcp_profiles.key`
- `ENCRYPTION_KEY` — supply a stable encryption key (recommended for shared environments)
- `LOG_LEVEL` — `error` / `warn` / `info` / `debug`

See `../mcp_config.md` for concrete configuration examples.

## Operational model (why it’s safe-by-default-ish)

- Inputs are validated and size-limited before execution (SQL length, URL length, command length, etc.).
- Secrets are encrypted at rest and never returned in plaintext via `list_profiles`.
- Execution is explicit: agents must provide fully specified SQL/commands/URLs (no templating).

Still: this project is infrastructure-grade. Run it only in environments you trust.

