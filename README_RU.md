 [LEGEND]

[CONTENT]
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
- Опциональный unsafe local режим для полной автономности агента (локальный exec + filesystem).

## UX для агента (quality-of-life)
- `help({ query })` умеет искать по ключевым словам в tools/actions/fields/aliases.
- Опечатки получают подсказки “did you mean” для tool/action/параметров.
- Ошибки типизированы и обычно дают `hint` + минимально рабочий пример.
- Безопасные дефолты: секреты редактируются везде; “сырой” экспорт секретов — opt-in и gated.
- Для долгих exec/SSH сценариев дефолтно больше явного статуса/прогресса, меньше “detached тишины”.

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
4. В MCP-клиенте вызовите `help` (попробуйте `help({ query: "ssh exec" })`), затем `profile_upsert` для PostgreSQL/SSH
5. Для автономных write-сценариев настройте `policy_profiles` (см. `docs/tools.md`)

## Инструменты
- `help`
- `legend`
- `mcp_workspace`
- `mcp_jobs`
- `mcp_artifacts`
- `mcp_psql_manager`
- `mcp_ssh_manager`
- `mcp_api_client`
- `mcp_state`
- `mcp_repo`
- `mcp_runbook`
- `mcp_project`
- `mcp_context`
- `mcp_env`
- `mcp_vault`
- `mcp_capability`
- `mcp_intent`
- `mcp_evidence`
- `mcp_alias`
- `mcp_preset`
- `mcp_audit`
- `mcp_pipeline`
- `mcp_local` (unsafe, опционально)

Короткие алиасы: например `sql`/`psql`, `ssh`, `api`/`http`, `repo`, `job`, `artifacts`, `workspace`, `intent`, `pipeline` (и `local`, если включён unsafe режим).

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
