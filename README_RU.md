# SentryFrogg MCP Server v4.2.0

> Русская версия | [English version](README.md)

## Обзор
SentryFrogg MCP Server предоставляет управляемый доступ для MCP-совместимых агентов к трём каналам взаимодействия: PostgreSQL, SSH и HTTP. Сервис ориентирован на воспроизводимость, предсказуемые ответы и строгие операционные правила, что делает его пригодным для корпоративных и исследовательских сред.

## Основные изменения в версии 4.2.0
- Поддержка клиентских сертификатов PostgreSQL: собственные CA, client cert/key и контроль `sslmode`.
- Единый bootstrap и три профильных менеджера; избыточная DI-логика удалена.
- Постоянное шифрование профилей с помощью AES-256 и возможностью задать внешний ключ.
- Унифицированные `action`-payload для PostgreSQL, SSH и HTTP инструментов.
- Телеметрические хуки `getStats()` для диагностики и мониторинга.

## Архитектура
```
simple_openmcp_server.cjs      # Точка входа MCP
src/
├── bootstrap/ServiceBootstrap.cjs
├── managers/
│   ├── PostgreSQLManager.cjs
│   ├── SSHManager.cjs
│   └── APIManager.cjs
├── services/
│   ├── Logger.cjs
│   ├── Security.cjs
│   ├── Validation.cjs
│   └── ProfileService.cjs
├── constants/Constants.cjs
└── mcp_config.md              # Краткая справка для агентов
```
Каждый менеджер имеет ограниченную зону ответственности; общие сервисы отвечают за логирование, валидацию и безопасное хранение профилей.

## Требования
- Node.js 16+ с установленным npm.
- Доступ к целевым экземплярам PostgreSQL, SSH-хостам и HTTP-сервисам.
- Право сохранять зашифрованные учётные данные на хостовой машине.

## Установка
```bash
git clone https://github.com/yourusername/sentryfrogg-mcp.git
cd sentryfrogg-mcp
npm install
```
Перед подключением к MCP-клиенту выполните синтаксическую проверку:
```bash
npm run check
```

## Интеграция с MCP-клиентом
Пример для Claude Desktop (Windows-путь указан для наглядности):
```json
{
  "mcpServers": {
    "sentryfrogg": {
      "command": "node",
      "args": ["C:\\path\\to\\sentryfrogg-mcp\\simple_openmcp_server.cjs"],
      "env": { "NODE_ENV": "production" }
    }
  }
}
```

## Безопасность и соответствие требованиям
- Секреты сохраняются в `profiles.json` и шифруются AES-256-CBC. Ключ создаётся при первом запуске и помещается в `.mcp_profiles.key` с правами `0600`.
- TLS-артефакты (`ssl_ca`, `ssl_cert`, `ssl_key`, `ssl_passphrase`) защищаются тем же ключом и не хранятся в открытом виде.
- Переменная `ENCRYPTION_KEY` позволяет задать управляемый ключ и переносить профили между машинами. Ротацию следует проводить в соответствии с внутренними процедурами.
- Валидируются обязательные поля, длины команд и последовательность SSH-вызовов, что исключает гонки и упрощает аудит.
- Перед публикацией или распространением репозитория проверьте, допустимо ли хранить `.mcp_profiles.key` в исходниках.

## Инструменты

### `mcp_psql_manager`
| Действие | Назначение | Минимальный запрос |
| --- | --- | --- |
| `setup_profile` | Сохранить PostgreSQL-профиль или `connection_url` | `{ "action": "setup_profile", "host": "localhost", "username": "postgres", "password": "xxx", "database": "mydb" }` |
| `list_profiles` | Получить список профилей | `{ "action": "list_profiles" }` |
| `quick_query` | Выполнить SQL с параметрами и авто-LIMIT | `{ "action": "quick_query", "sql": "SELECT * FROM users WHERE id = $1", "params": [1] }` |
| `show_tables` | Показать пользовательские таблицы | `{ "action": "show_tables" }` |
| `describe_table` | Столбцы и типы | `{ "action": "describe_table", "table_name": "users" }` |
| `sample_data` | Получить выборку строк | `{ "action": "sample_data", "table_name": "users", "limit": 10 }` |
| `insert_data` | Записать JSON-объекты | `{ "action": "insert_data", "table_name": "users", "data": { "name": "Ada" } }` |
| `update_data` | Обновить записи через `where` | `{ "action": "update_data", "table_name": "users", "data": { "active": true }, "where": "id = 1" }` |
| `delete_data` | Удалить строки | `{ "action": "delete_data", "table_name": "users", "where": "id = 1" }` |
| `database_info` | Получить сводку БД | `{ "action": "database_info" }` |

**TLS-параметры** — добавьте их в `setup_profile`, если БД требует клиентские сертификаты:

```jsonc
{
  "action": "setup_profile",
  "profile_name": "prod",
  "connection_url": "postgres://postgres@db.internal:5432/core?sslmode=verify-full",
  "ssl_ca": "-----BEGIN CERTIFICATE-----...",
  "ssl_cert": "-----BEGIN CERTIFICATE-----...",
  "ssl_key": "-----BEGIN PRIVATE KEY-----...",
  "ssl_passphrase": "optional",
  "ssl_servername": "db.internal",
  "ssl_reject_unauthorized": true
}
```

Файлы шифруются и хранятся в `profiles.json`. Используйте `ssl_mode` (`disable`, `require`, `verify-ca`, `verify-full`), если параметры не передаются через `connection_url`.

### `mcp_ssh_manager`
| Действие | Назначение | Минимальный запрос |
| --- | --- | --- |
| `setup_profile` | Сохранить SSH-конфигурацию | `{ "action": "setup_profile", "host": "example.com", "username": "root", "password": "xxx" }` |
| `list_profiles` | Список доступных профилей | `{ "action": "list_profiles" }` |
| `execute` | Последовательное выполнение команд | `{ "action": "execute", "command": "ls -la" }` |
| `system_info` | Системные сведения | `{ "action": "system_info" }` |
| `check_host` | Проверка доступности узла | `{ "action": "check_host" }` |

### `mcp_api_client`
| Действие | Назначение | Минимальный запрос |
| --- | --- | --- |
| `get` / `post` / `put` / `delete` / `patch` | HTTP-запросы с JSON-телом | `{ "action": "get", "url": "https://api.example.com/users" }` |
| `check_api` | Health-check конечной точки | `{ "action": "check_api", "url": "https://api.example.com/ping" }` |

Заголовки передаются в объекте `headers`, тела запросов — в `data` и сериализуются в JSON автоматически.

## Типовой сценарий
```jsonc
// 1. Сохранить профиль PostgreSQL
{ "action": "setup_profile", "connection_url": "postgres://postgres:postgres@localhost:5432/demo" }

// 2. Просмотреть таблицы
{ "action": "show_tables" }

// 3. Извлечь образцы данных
{ "action": "sample_data", "table_name": "users", "limit": 5 }

// 4. Добавить SSH-профиль с приватным ключом
{ "action": "setup_profile", "profile_name": "prod", "host": "myserver.com", "username": "ubuntu", "private_key": "-----BEGIN...", "passphrase": "secret" }

// 5. Проверить доступность хоста
{ "action": "check_host", "profile_name": "prod" }

// 6. Вызвать внутренний HTTP-сервис
{ "action": "get", "url": "http://localhost:3000/status" }
```

## Эксплуатация
- `npm run check` проверяет точку входа.
- Функциональные сценарии выполняются через MCP-клиенты цепочкой профилей и действий.
- Метод `getStats()` для каждого менеджера помогает собрать телеметрию и показатели использования.

## Поддержка и вклад
1. Сделайте форк и заведите фиче-ветку.
2. Реализуйте изменения, дополнив их примерами использования.
3. Выполните `npm run check` перед публикацией.
4. Отправьте pull request с кратким описанием и результатами проверки.

Лицензия — MIT. Все изменения должны соответствовать внутренним стандартам качества и безопасности.
