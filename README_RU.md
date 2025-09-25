# 🚀 КОМПАКТНЫЙ PostgreSQL + API + SSH MCP СЕРВЕР v4.1.0

> Агент может копировать примеры как есть — всё совпадает с реализацией.

## 🎯 Новое в 4.1.0
- ✅ Минимальная архитектура: один bootstrap, три менеджера, никакой «магии»
- ✅ Постоянный шифровальный ключ — создаётся один раз и хранится в `.mcp_profiles.key`
- ✅ Единый формат `action` во всех инструментах
- ✅ Последовательное выполнение SSH-команд, удобные ответы в JSON
- ✅ Документация полностью синхронизирована с кодом

## 🏗️ Структура
```
simple_openmcp_server.cjs
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
└── constants/Constants.cjs
```

## 🔧 Установка
```bash
git clone https://github.com/yourusername/psql-ssh-api.git
cd psql-ssh-api
npm install
npm run check
```

## 🔐 Профили и безопасность
- Пароли шифруются AES-256-CBC и хранятся в `profiles.json`
- Ключ лежит в `.mcp_profiles.key` (права `0600`)
- Переменная `ENCRYPTION_KEY` позволяет задать ключ вручную или поделиться профилями
- Валидация минимальна: только проверка корректности и длины, никаких избыточных запретов

## 🛠️ Инструменты

### `mcp_psql_manager`
| Действие | Что делает | Минимальный запрос |
| --- | --- | --- |
| `setup_profile` | Сохраняет подключение или `connection_url` | `{ "action": "setup_profile", "connection_url": "postgres://postgres:postgres@localhost:5432/demo" }` |
| `list_profiles` | Показывает профили | `{ "action": "list_profiles" }` |
| `quick_query` | Исполняет SQL, добавляя `LIMIT`; поддерживает `params` | `{ "action": "quick_query", "sql": "SELECT * FROM users WHERE id = $1", "params": [1] }` |
| `show_tables` | Список таблиц | `{ "action": "show_tables" }` |
| `describe_table` | Структура таблицы | `{ "action": "describe_table", "table_name": "users" }` |
| `sample_data` | Семпл данных | `{ "action": "sample_data", "table_name": "users", "limit": 5 }` |
| `insert_data` | Вставка JSON-объекта | `{ "action": "insert_data", "table_name": "users", "data": { "name": "Ада" } }` |
| `update_data` | Обновление строк | `{ "action": "update_data", "table_name": "users", "data": { "active": true }, "where": "id = 1" }` |
| `delete_data` | Удаление | `{ "action": "delete_data", "table_name": "users", "where": "id = 1" }` |
| `database_info` | Короткая сводка по БД | `{ "action": "database_info" }` |

### `mcp_ssh_manager`
| Действие | Описание | Пример |
| --- | --- | --- |
| `setup_profile` | Сохраняет SSH-хост (пароль или приватный ключ) | `{ "action": "setup_profile", "profile_name": "prod", "host": "example.com", "username": "root", "private_key": "-----BEGIN...", "passphrase": "secret" }` |
| `list_profiles` | Список доступных профилей | `{ "action": "list_profiles" }` |
| `execute` | Выполняет команду (поддерживаются пайпы, редиректы) | `{ "action": "execute", "profile_name": "prod", "command": "ls -la" }` |
| `system_info` | Системные факты | `{ "action": "system_info", "profile_name": "prod" }` |
| `check_host` | Быстрая проверка доступности | `{ "action": "check_host", "profile_name": "prod" }` |

### `mcp_api_client`
| Действие | Описание | Пример |
| --- | --- | --- |
| `get` / `post` / `put` / `delete` / `patch` | HTTP-методы | `{ "action": "get", "url": "https://api.example.com/users" }` |
| `check_api` | Health-check | `{ "action": "check_api", "url": "http://localhost:3000/status" }` |

- Тело запроса передаётся в `data`
- Заголовки — в `headers`
- Локальные и приватные адреса разрешены

## ⚡ Минимальный сценарий
```jsonc
// PostgreSQL
{ "action": "setup_profile", "connection_url": "postgres://postgres:postgres@localhost:5432/demo" }
{ "action": "show_tables" }

// SSH
{ "action": "setup_profile", "profile_name": "prod", "host": "myserver.com", "username": "ubuntu", "private_key": "-----BEGIN...", "passphrase": "secret" }
{ "action": "check_host", "profile_name": "prod" }

// HTTP
{ "action": "get", "url": "http://127.0.0.1:8080/ping" }
```

## 🧪 Проверки
- `npm run check` — синтаксическая проверка `simple_openmcp_server.cjs`
- Функциональные сценарии легко прогнать из MCP-клиента (Claude, Cursor, и т.д.)

## 📄 Лицензия
MIT. Улучшайте и используйте свободно!
