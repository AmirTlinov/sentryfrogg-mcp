# SentryFrogg MCP Server

[English](README.md) • [Docs](docs/README.md) • [Конфигурация MCP](mcp_config.md) • [Интеграционный стенд](integration/README.md) • [История изменений](CHANGELOG.md)

SentryFrogg — MCP-сервер (stdio) для PostgreSQL, SSH, HTTP, state, runbook и пайплайнов с чистой системой профилей.

## Возможности
- PostgreSQL: профили или inline-подключения, запросы/батчи/транзакции, CRUD + select/count/exists/export
- SSH: exec/batch, диагностика, SFTP (list/upload/download)
- HTTP: профили, auth providers, retry/backoff, пагинация, download, cache
- State + runbooks: переменные между вызовами, многошаговые сценарии, DSL
- Aliases + presets: короткие имена и переиспользуемые наборы аргументов
- Pipelines: потоковые HTTP↔SFTP↔PostgreSQL сценарии
- Observability: trace/span метаданные + аудит-лог
- Output shaping + `store_as` для лёгких пайплайнов данных
- Профили шифруются (AES-256-GCM) и сохраняются локально
- Логи пишутся в **stderr** (stdout — под MCP JSON-RPC)

Требования: Node.js `>=18`, npm `>=8`.

## Быстрый старт
1. Установите зависимости: `npm install`
2. Зарегистрируйте сервер в MCP-клиенте (stdio): см. `mcp_config.md`
3. Запустите сервер: `npm start`
4. В MCP-клиенте вызовите `help`, затем `profile_upsert` для PostgreSQL/SSH

## Инструменты
- `help`
- `mcp_psql_manager`
- `mcp_ssh_manager`
- `mcp_api_client`
- `mcp_state`
- `mcp_runbook`
- `mcp_alias`
- `mcp_preset`
- `mcp_audit`
- `mcp_pipeline`

Короткие алиасы: `sql`, `psql`, `ssh`, `http`, `api`, `state`, `runbook`, `pipeline`.

Примеры и паттерны вызовов: `docs/tools.md`.

## Разработка
- `npm run check`
- `npm test`
- `npm run smoke` (Docker) — см. `integration/README.md`

## Безопасность
Сервер умеет выполнять SQL/SSH/HTTP по замыслу — запускайте только в доверенной среде.

- Репорт уязвимостей: `SECURITY.md`
- Чеклист перед публикацией: `PUBLIC_RELEASE_CHECKLIST.md`

## Лицензия
MIT — см. `LICENSE`.
