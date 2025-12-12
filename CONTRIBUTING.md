# Contributing

Thanks for taking the time to contribute to SentryFrogg.

## Development setup

Prerequisites:
- Node.js `>=18`
- npm `>=8`
- Docker (optional, for `npm run smoke`)

Install dependencies:
- `npm install` (local development)
- `npm ci` (recommended for CI / reproducible installs)

## Useful scripts

- `npm start` — run the MCP server over stdio
- `npm run check` — syntax check (`node --check`)
- `npm test` — run the Node.js test suite
- `npm run smoke` — validate Docker-backed integration targets (see `integration/README.md`)

## Pull requests

- Keep PRs focused and easy to review.
- Include evidence of verification (`npm run check` and `npm test`).
- Update documentation when behaviour or tool schemas change.

## Security and secrets

- Do **not** commit `profiles.json` or `.mcp_profiles.key` (local state only).
- Prefer storing local profile state outside the repository via `MCP_PROFILES_DIR` / `MCP_PROFILE_KEY_PATH`.
- For security reports, see `SECURITY.md`.
