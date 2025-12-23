# SentryFrogg MCP Server

[English](README.md) • [Docs](docs/README.md) • [Конфигурация MCP](mcp_config.md) • [Интеграционный стенд](integration/README.md) • [История изменений](CHANGELOG.md)

![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![Node.js >=18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
[![CI](https://github.com/AmirTlinov/sentryfrogg-mcp/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/AmirTlinov/sentryfrogg-mcp/actions/workflows/ci.yml)

SentryFrogg — MCP-сервер (stdio), который даёт LLM-агентам продакшн-инструментарий для PostgreSQL, SSH (включая SFTP) и HTTP.
Подходит, когда нужен доступ к реальной инфраструктуре без glue-скриптов: профили, потоковые пайплайны, runbooks и аудит уже есть.

Если вы хотите, чтобы агент гонял реальные данные (API ↔ SFTP ↔ Postgres), делал управляемые SSH-операции и оставлял понятный след — это оно.

## Почему SentryFrogg
- Единая система профилей для Postgres, SSH и HTTP.
- Потоковые пайплайны между HTTP, SFTP и Postgres для больших объёмов.
- Надёжность: retry/backoff, пагинация, таймауты.
- Runbooks + state для многошаговых сценариев и воспроизводимых операций.
- Наблюдаемость: trace/span метаданные и аудит-лог с редактированием.
- Профили шифруются (AES-256-GCM) и хранятся локально.
- Безопасные дефолты для записи файлов (без перезаписи, если не указать `overwrite: true`).

## Сценарии
- Синхронизация или бэкфилл данных между API, SFTP и PostgreSQL.
- Контролируемые операции по SSH с аудитом.
- Повторяемые runbook-цепочки для агентов и инженеров.

## Быстрые примеры
Загрузка JSONL в Postgres:

```json
{
  "action": "run",
  "flow": "http_to_postgres",
  "http": { "url": "https://example.com/events.jsonl" },
  "postgres": { "profile_name": "default", "table": "events" },
  "format": "jsonl",
  "batch_size": 500
}
```

Экспорт Postgres в SFTP:

```json
{
  "action": "run",
  "flow": "postgres_to_sftp",
  "postgres": { "profile_name": "default", "table": "events" },
  "format": "csv",
  "sftp": { "profile_name": "default", "remote_path": "/tmp/events.csv", "overwrite": true }
}
```

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
