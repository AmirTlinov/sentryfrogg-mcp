# SentryFrogg MCP Server v4.2.0 — Краткий справочник

## Общие правила
- Сначала выполняйте `setup_profile`, затем используйте остальные действия без передачи секретов.
- Поле `action` определяет сценарий работы каждого менеджера.
- Ответы возвращаются в JSON-формате и включают признак успешности.

---

## PostgreSQL (`mcp_psql_manager`)

### Создание или обновление профиля
```json
{
  "action": "setup_profile",
  "profile_name": "default",
  "connection_url": "postgres://postgres:postgres@localhost:5432/demo"
}
```

### TLS-профиль
```json
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

### Базовые действия
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

Примечание: при отсутствии `LIMIT` в `quick_query` сервер добавит `LIMIT 100`.

---

## SSH (`mcp_ssh_manager`)

### Создание профиля
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

### Выполнение команды
```json
{
  "action": "execute",
  "profile_name": "prod",
  "command": "ls -la | head"
}
```

### Проверки
```json
{ "action": "list_profiles" }
{ "action": "system_info", "profile_name": "prod" }
{ "action": "check_host", "profile_name": "prod" }
```

Команды выполняются последовательно для каждого профиля.

---

## HTTP (`mcp_api_client`)

### GET-запрос
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

Заголовки передавайте через объект `headers`. Локальные адреса разрешены.

---

## Типовой сценарий
```jsonc
// Последовательность: база данных → SSH → HTTP
{ "action": "setup_profile", "connection_url": "postgres://postgres:postgres@localhost:5432/demo" }
{ "action": "quick_query", "sql": "SELECT COUNT(*) FROM users" }
{ "action": "setup_profile", "profile_name": "prod", "host": "myserver.com", "username": "ubuntu", "private_key": "-----BEGIN..." }
{ "action": "check_host", "profile_name": "prod" }
{ "action": "get", "url": "http://127.0.0.1:8080/health" }
```

Готовый сценарий минимизирует число уточнений со стороны агента.
