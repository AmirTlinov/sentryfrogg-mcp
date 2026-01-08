 [LEGEND]

[CONTENT]
# Security Policy

SentryFrogg is an MCP server capable of executing SQL, SSH commands, and HTTP requests. Treat it as privileged infrastructure software.

## Unsafe local mode

SentryFrogg also has an **optional** local-machine tool (`mcp_local`) that can execute commands and access the host filesystem.
It is **disabled by default** and is only exposed when you explicitly set `SENTRYFROGG_UNSAFE_LOCAL=1` (or `SF_UNSAFE_LOCAL=1`).

Enable it only in environments you fully trust.

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities.

Preferred:
- Use GitHub Security Advisories (private vulnerability reporting) for this repository.

If advisories are not available:
- Contact the repository maintainers via GitHub and request a private channel for disclosure.

## Supported versions

Only the latest released version is supported with security updates.

## Handling secrets

- `profiles.json` and `.mcp_profiles.key` are local state and must never be committed.
- If secrets were accidentally committed in git history: rotate credentials, change `ENCRYPTION_KEY`, and purge history before making the repository public (e.g., `git filter-repo` / BFG).
