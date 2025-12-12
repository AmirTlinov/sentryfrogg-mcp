# SentryFrogg MCP Server v4.2.0

[Русская версия](README_RU.md) • [MCP configuration](mcp_config.md) • [Integration stack](integration/README.md) • [Changelog](CHANGELOG.md)

![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![Node.js >=18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
[![CI](https://github.com/AmirTlinov/SentryFrogg-MCP/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/AmirTlinov/SentryFrogg-MCP/actions/workflows/ci.yml)

## Document Profile
| Field | Value |
| --- | --- |
| Product | SentryFrogg MCP Server |
| Version | 4.2.0 |
| Runtime | Node.js ≥ 18 |
| Interfaces | Model Context Protocol (PostgreSQL · SSH · HTTP) |
| License | MIT |

## Executive Synopsis
SentryFrogg MCP Server supplies a governed command plane for MCP-compatible agents that operate data platforms, remote shells and web services. The implementation prioritises deterministic behaviour, encrypted credential storage and prescriptive workflows so that autonomous agents can execute infrastructure tasks with enterprise auditability.

## Quick Start
1. Install dependencies: `npm install`
2. Register the server in your MCP client (stdio): see [mcp_config.md](mcp_config.md)
3. Start the server: `npm start`
4. In your MCP client, call `help`, then `setup_profile` for PostgreSQL/SSH (the HTTP client is stateless)

Notes:
- Server logs are written to **stderr** to keep MCP stdout clean.

## Functional Surface
| Capability | Detail |
| --- | --- |
| PostgreSQL control | Parameterised SQL, catalog discovery, CRUD helpers, mutual TLS, connection profiling. |
| SSH execution | Serial command dispatch per profile, password/key authentication, reachability diagnostics. |
| HTTP access | REST verbs with JSON payloads, health checks, programmable headers and bearer tokens. |
| Secret vault | AES-256 encrypted profiles persisted in `profiles.json` with managed key material. |
| Telemetry | Tool-level statistics via `getStats()` for integration with monitoring stacks. |

## System Components
| Component | Scope |
| --- | --- |
| `sentryfrogg_server.cjs` | MCP entry point, tool catalogue, lifecycle supervision. |
| `src/bootstrap/ServiceBootstrap.cjs` | Service registration, dependency wiring, resource cleanup. |
| `src/managers/PostgreSQLManager.cjs` | SQL execution, profile validation, TLS configuration, pool management. |
| `src/managers/SSHManager.cjs` | SSH sessions, sequential execution enforcement, profile hygiene. |
| `src/managers/APIManager.cjs` | HTTP invocation, header synthesis, response shaping. |
| `src/services/ProfileService.cjs` | Encrypted persistence and retrieval of profile objects. |
| `src/services/Security.cjs` | Key lifecycle, cryptographic primitives, payload size guards. |
| `src/services/Validation.cjs` | Canonical validation for incoming payloads. |

## MCP Tools
### `help`
| Attribute | Specification |
| --- | --- |
| Purpose | Provide quick guidance on how to work with SentryFrogg and its tools. |
| Arguments | Optional `tool` string to focus the response on a single instrument. |
| Output | Text summary plus structured JSON overview of tools and usage patterns. |
| Typical flow | `call_tool` → `name: "help"` (with or without `arguments.tool`). |

### `mcp_psql_manager`
| Attribute | Specification |
| --- | --- |
| Required flow | `setup_profile` → downstream action using same `profile_name`. |
| Actions | `setup_profile`, `list_profiles`, `quick_query`, `show_tables`, `describe_table`, `sample_data`, `insert_data`, `update_data`, `delete_data`, `database_info`. |
| Credentials | Either discrete fields (`host`, `port`, `username`, `password`, `database`) or `connection_url`. |
| TLS options | `ssl_mode`, `ssl_ca`, `ssl_cert`, `ssl_key`, `ssl_passphrase`, `ssl_servername`, `ssl_reject_unauthorized`; omitted values reuse stored secrets. |
| Query rules | `quick_query` injects `LIMIT 100` when absent; bind variables supplied via `params` array (`$1`, `$2`, ...). |
| Response format | JSON with `success`, `rows`, `rowCount`, `fields`, `command`; failures raise MCP internal errors. |
| Rejection triggers | Missing profile, malformed SQL, payload limits exceeded, invalid TLS configuration. |

### `mcp_ssh_manager`
| Attribute | Specification |
| --- | --- |
| Required flow | `setup_profile` (password or PEM `private_key`, optional `passphrase`) → operational action. |
| Actions | `setup_profile`, `list_profiles`, `execute`, `system_info`, `check_host`. |
| Execution model | Commands trimmed and length-limited; pipes/redirects permitted; per-profile execution is strictly sequential. |
| Outputs | JSON containing `success`, `stdout`, `stderr`, `exitCode`, `durationMs`; errors propagate as MCP internal errors. |
| Security posture | Secrets encrypted at rest; no templating—agents must supply fully qualified commands. |

### `mcp_api_client`
| Attribute | Specification |
| --- | --- |
| Actions | `get`, `post`, `put`, `delete`, `patch`, `check_api`. |
| Inputs | `url` (required), `data` (JSON body for mutating verbs), `headers` (string map), `auth_token` (prefixed into `Authorization` unless already set). |
| Behaviour | Local and private addresses allowed; HTTP status/body returned in structured JSON; transport or parsing failures emit MCP internal errors. |

## Profile Lifecycle
1. Invoke `setup_profile` to persist credentials and TLS artefacts; secrets encrypt with AES-256 using `.mcp_profiles.key` (`0600` permissions).  
2. Reference the same `profile_name` for subsequent operations; omitted sensitive fields inherit stored encrypted values.  
3. Rotate credentials by reissuing `setup_profile`; the latest payload supersedes previous entries.  
4. Audit existing profiles via `list_profiles`; responses never disclose secrets.  
5. Retire unused profiles by editing `profiles.json` under change control.  
6. Use `profiles.example.json` as a template when creating new environments; never commit live `profiles.json` or `.mcp_profiles.key`.

## TLS Configuration Guidance
- Prefer embedding `sslmode` directives in `connection_url`; explicit payload fields override URL parameters.  
- Keep `ssl_reject_unauthorized` at `true` unless communicating with trusted self-signed endpoints.  
- Provide `ssl_servername` whenever certificate CN/SAN mismatches the host.  
- Supply PEM blocks as single-line strings using `\n` escape sequences; leading/trailing spaces are disallowed.  
- `ssl_passphrase` must be non-empty if provided; omit otherwise.

## Installation and Operations
| Task | Command |
| --- | --- |
| Clone and install | `git clone https://github.com/AmirTlinov/SentryFrogg-MCP.git && cd SentryFrogg-MCP && npm install` |
| Start (stdio) | `npm start` |
| Syntax check | `npm run check` |
| Unit tests | `npm test` |
| Start integration targets (Docker) | `docker compose -f integration/docker-compose.yml up -d --build` |
| Integration smoke test | `npm run smoke` |
| Stop integration targets | `docker compose -f integration/docker-compose.yml down -v` |
| Reset local profile store | Remove `profiles.json` and `.mcp_profiles.key` after confirming backups |

## Security & Compliance
- Encryption key lifecycle: `.mcp_profiles.key` generated on first run; override via `ENCRYPTION_KEY` for coordinated environments.  
- Secret exposure: MCP responses never include decrypted values; rotation requires explicit `setup_profile`.  
- Input governance: SQL statements, SSH commands and HTTP payloads are length-limited; oversized inputs are rejected pre-execution.  
- Audit trail: stderr logging captures timestamped events per tool to support collection by SIEM platforms.  
- Dependency governance: locked versions of `pg`, `ssh2`, `node-fetch`, `@modelcontextprotocol/sdk`; monitor advisories for patch cadence.
- Vulnerability reporting: see [SECURITY.md](SECURITY.md).
- Public release checklist: see [PUBLIC_RELEASE_CHECKLIST.md](PUBLIC_RELEASE_CHECKLIST.md).

## Troubleshooting Matrix
| Symptom | Diagnostic Actions | Remediation |
| --- | --- | --- |
| PostgreSQL TLS failure | Inspect `ssl_mode`, `ssl_servername`, certificate chain, Postgres logs. | Update TLS materials; rerun `setup_profile`. |
| SSH command hang | Validate command length, ensure non-interactive execution, check remote prompts. | Adjust command or script; rerun `setup_profile` if credentials changed. |
| HTTP error response | Review returned status/body, verify `headers` and `auth_token`. | Correct payload; retry request. |
| Missing profile | Execute `list_profiles` to confirm presence; ensure consistent `profile_name`. | Recreate via `setup_profile`. |

## Change History Reference
Consult [CHANGELOG.md](CHANGELOG.md) for a dated record of functional and operational updates, including TLS support and renaming.

## Contribution & Support
- See [CONTRIBUTING.md](CONTRIBUTING.md) for development workflow and style expectations.  
- Security issues: follow [SECURITY.md](SECURITY.md).  
- Community standards: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Testing
- `npm test` runs the Node.js test suite (including the STDIO handshake smoke test).
- `npm run smoke` validates the Docker-backed integration targets; see `integration/README.md`.
