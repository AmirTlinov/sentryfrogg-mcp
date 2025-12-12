# SentryFrogg MCP Server v4.2.0

[English](README.md) • [Конфигурация MCP](mcp_config.md) • [Интеграционный стенд](integration/README.md) • [История изменений](CHANGELOG.md)

SentryFrogg — MCP-сервер (stdio) для управляемых операций с:
- PostgreSQL (`mcp_psql_manager`)
- SSH (`mcp_ssh_manager`)
- HTTP (`mcp_api_client`)

## Быстрый старт
1. Установите зависимости: `npm install`
2. Зарегистрируйте сервер в вашем MCP-клиенте (stdio): см. [mcp_config.md](mcp_config.md)
3. Запустите сервер: `npm start`
4. В MCP-клиенте вызовите `help`, затем `setup_profile` для PostgreSQL/SSH (HTTP-клиент без профилей)

Требования: Node.js `>=18`, npm `>=8`.

## Скрипты разработки
| Задача | Команда |
| --- | --- |
| Старт | `npm start` |
| Проверка синтаксиса | `npm run check` |
| Unit-тесты | `npm test` |
| Интеграционные цели (Docker) | `docker compose -f integration/docker-compose.yml up -d --build` |
| Smoke-прогон интеграции | `npm run smoke` |
| Остановка стенда | `docker compose -f integration/docker-compose.yml down -v` |

## Профили и безопасность
- Локальное состояние хранится в `profiles.json`, ключ — в `.mcp_profiles.key` (создаётся автоматически).
- Не коммитьте `profiles.json` и `.mcp_profiles.key`. Для надёжности вынесите их за пределы репозитория через `MCP_PROFILES_DIR` / `MCP_PROFILE_KEY_PATH`.
- Про уязвимости и disclosure: [SECURITY.md](SECURITY.md).
- Чеклист перед публикацией: [PUBLIC_RELEASE_CHECKLIST.md](PUBLIC_RELEASE_CHECKLIST.md).

## Вклад и правила сообщества
- Как контрибьютить: [CONTRIBUTING.md](CONTRIBUTING.md).
- Кодекс поведения: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Лицензия
MIT: см. [LICENSE](LICENSE).
