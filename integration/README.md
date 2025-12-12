# Integration Stacks

This directory provides local Docker targets for integration testing of the MCP tools.

## Quick run (EN)

- Start: `docker compose -f integration/docker-compose.yml up -d --build`
- Smoke check: `npm run smoke`
- Stop: `docker compose -f integration/docker-compose.yml down -v`

### Smoke environment overrides

`integration/smoke.cjs` supports:
- `SF_PG_URI` (default: `postgresql://mcp_user:mcp_pass@127.0.0.1:5432/mcp_demo`)
- `SF_SSH_HOST` (default: `127.0.0.1`)
- `SF_SSH_PORT` (default: `2222`)
- `SF_SSH_USER` (default: `mcp`)
- `SF_SSH_PASSWORD` (default: `mcp_pass`)

---

## Русский

Этот каталог предоставляет локальные стенды для интеграционного тестирования MCP-инструментов.

## Сервисы

- **PostgreSQL** (`postgres:16-alpine`): база `mcp_demo`, пользователь `mcp_user`, пароль `mcp_pass`, порт `5432`.
- **SSH** (кастомный Alpine OpenSSH): пользователь `mcp`, пароль `mcp_pass`, порт `2222`.

## Запуск

```bash
docker compose -f integration/docker-compose.yml up -d --build
```

После запуска сервисов выполните локальный smoke-прогон:

```bash
npm run smoke
```

## Остановка

```bash
docker compose -f integration/docker-compose.yml down -v
```

## Проверка доступности

- PostgreSQL: `psql postgresql://mcp_user:mcp_pass@127.0.0.1:5432/mcp_demo`
- SSH: `ssh mcp@127.0.0.1 -p 2222` (пароль `mcp_pass`)

## Использование с MCP инструментами

После запуска стенда можно вызывать `setup_profile` с параметрами:

```json
{
  "action": "setup_profile",
  "profile_name": "integration",
  "host": "127.0.0.1",
  "port": 5432,
  "username": "mcp_user",
  "password": "mcp_pass",
  "database": "mcp_demo"
}
```

и

```json
{
  "action": "setup_profile",
  "profile_name": "integration-ssh",
  "host": "127.0.0.1",
  "port": 2222,
  "username": "mcp",
  "password": "mcp_pass"
}
```
