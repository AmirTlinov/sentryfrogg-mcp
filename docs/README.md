 [LEGEND]

[CONTENT]
# Documentation

This directory contains the long-form documentation for SentryFrogg.

## Quick demo
1. Configure your MCP client (stdio): see `../mcp_config.md`.
2. Start the server: `npm start`.
3. Create a Postgres profile:

   ```json
   {
     "action": "profile_upsert",
     "profile_name": "default",
     "connection": {
       "host": "127.0.0.1",
       "port": 5432,
       "username": "mcp_user",
       "password": "mcp_pass",
       "database": "mcp_demo"
     }
   }
   ```

4. Stream JSONL into Postgres:

   ```json
   {
     "action": "run",
     "flow": "http_to_postgres",
     "http": { "url": "https://example.com/events.jsonl" },
     "postgres": { "profile_name": "default", "table": "events" },
     "format": "jsonl"
   }
   ```

5. Inspect audit entries: call `mcp_audit` with `action: "list"`.

## Index

- **Getting started**
  - `../README.md` (project overview)
  - `../mcp_config.md` (MCP client config, profiles/keys, examples)
- **Reference**
  - `tools.md` (tool overview + common call patterns)
- **Architecture**
  - `architecture.md` (how the server is structured)
- **Integration**
  - `../integration/README.md` (Docker targets + smoke test)
- **Security**
  - `../SECURITY.md` (vulnerability reporting policy)
  - `../PUBLIC_RELEASE_CHECKLIST.md` (safe public release checklist)
