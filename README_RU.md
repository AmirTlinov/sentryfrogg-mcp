# SentryFrogg MCP Server

[English](README.md) • [Docs](docs/README.md) • [Конфигурация MCP](mcp_config.md) • [Интеграционный стенд](integration/README.md) • [История изменений](CHANGELOG.md)

SentryFrogg — MCP-сервер (stdio) для операций с PostgreSQL, SSH и HTTP.

## Возможности
- PostgreSQL: параметризованные запросы, хелперы каталога, опциональный client TLS
- SSH: последовательное выполнение команд в рамках профиля
- HTTP: простой клиент с заголовками и bearer-токенами
- Профили шифруются и хранятся локально (`profiles.json` + `.mcp_profiles.key`)
- Логи пишутся в **stderr** (stdout — под MCP JSON-RPC)

Требования: Node.js `>=18`, npm `>=8`.

## Быстрый старт
1. Установите зависимости: `npm install`
2. Зарегистрируйте сервер в MCP-клиенте (stdio): см. `mcp_config.md`
3. Запустите сервер: `npm start`
4. В MCP-клиенте вызовите `help`, затем `setup_profile` для PostgreSQL/SSH

## Инструменты
- `help`
- `mcp_psql_manager`
- `mcp_ssh_manager`
- `mcp_api_client`

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

