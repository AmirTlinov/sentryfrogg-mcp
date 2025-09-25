# 🚀 MCP SERVER v4.1.0 — КОНСПЕКТ ДЛЯ АГЕНТОВ

## 📌 ОБЩИЕ ПРАВИЛА
- Сначала создаём профиль (`setup_profile`), затем используем остальные действия без пароля
- Один JSON-параметр `action` определяет всё поведение
- Ответы всегда приходят в JSON и содержат `success`

---

## 🗄️ PostgreSQL (`mcp_psql_manager`)

### Создать/обновить профиль
```json
{
  "action": "setup_profile",
  "profile_name": "default",
  "connection_url": "postgres://postgres:postgres@localhost:5432/demo"
}
```

### Полезные действия
```json
{ "action": "list_profiles" }
{ "action": "show_tables" }
{ "action": "describe_table", "table_name": "users" }
{ "action": "sample_data", "table_name": "users", "limit": 5 }
{ "action": "quick_query", "sql": "SELECT * FROM users WHERE id = $1", "params": [1] }
{ "action": "insert_data", "table_name": "users", "data": { "name": "Ada" } }
{ "action": "update_data", "table_name": "users", "data": { "active": true }, "where": "id = 1" }
{ "action": "delete_data", "table_name": "users", "where": "id = 1" }
{ "action": "database_info" }
```

> Совет: если в `quick_query` нет `LIMIT`, сервер автоматически добавит `LIMIT 100`.

---

## 🔐 SSH (`mcp_ssh_manager`)

### Создать профиль
```json
{
  "action": "setup_profile",
  "profile_name": "prod",
  "host": "myserver.com",
  "username": "ubuntu",
  "private_key": "-----BEGIN...",
  "passphrase": "secret"
}
```

### Выполнить команду
```json
{
  "action": "execute",
  "profile_name": "prod",
  "command": "ls -la | head"
}
```

### Быстрые проверки
```json
{ "action": "list_profiles" }
{ "action": "system_info", "profile_name": "prod" }
{ "action": "check_host", "profile_name": "prod" }
```

Команды исполняются последовательно для каждого профиля, поэтому `system_info` и `execute` не мешают друг другу.

---

## 🌐 HTTP (`mcp_api_client`)

### Базовый GET
```json
{
  "action": "get",
  "url": "https://api.example.com/users"
}
```

### POST с телом и токеном
```json
{
  "action": "post",
  "url": "https://api.example.com/users",
  "data": { "name": "Ada" },
  "auth_token": "Bearer abc.def.ghi"
}
```

### Health-check
```json
{
  "action": "check_api",
  "url": "http://localhost:3000/status"
}
```

> Заголовки можно передавать через объект `headers`. Локальные URL разрешены.

---

## ⚡ Типовой сценарий
```jsonc
// DB -> SSH -> HTTP за пару шагов
{ "action": "setup_profile", "connection_url": "postgres://postgres:postgres@localhost:5432/demo" }
{ "action": "quick_query", "sql": "SELECT COUNT(*) FROM users" }
{ "action": "setup_profile", "profile_name": "prod", "host": "myserver.com", "username": "ubuntu", "private_key": "-----BEGIN..." } // вызвать в инструменте mcp_ssh_manager
{ "action": "check_host", "profile_name": "prod" }
{ "action": "get", "url": "http://127.0.0.1:8080/health" }
```

Готово! Больше никаких догадок — только прямые команды.
