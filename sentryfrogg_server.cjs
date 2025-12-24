#!/usr/bin/env node

// SentryFrogg MCP Server v6.4.0

process.on('unhandledRejection', (reason, promise) => {
  process.stderr.write(`🔥 Unhandled Promise Rejection: ${reason}\n`);
  process.stderr.write(`Promise: ${promise}\n`);
});

process.on('uncaughtException', (error) => {
  process.stderr.write(`🔥 Uncaught Exception: ${error.message}\n`);
  process.exit(1);
});

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} = require('@modelcontextprotocol/sdk/types.js');
const crypto = require('crypto');

const ServiceBootstrap = require('./src/bootstrap/ServiceBootstrap.cjs');
const { isUnsafeLocalEnabled } = require('./src/utils/featureFlags.cjs');

const outputSchema = {
  type: 'object',
  description: 'Output shaping (path/pick/omit/map).',
  properties: {
    path: { type: 'string' },
    pick: { type: 'array', items: { type: 'string' } },
    omit: { type: 'array', items: { type: 'string' } },
    map: { type: 'object' },
    missing: { type: 'string', enum: ['error', 'empty', 'null', 'undefined'] },
    default: { type: ['string', 'number', 'boolean', 'object', 'array', 'null'] },
  },
  additionalProperties: true,
};

const toolCatalog = [
  {
    name: 'help',
    description: 'Краткая справка по использованию SentryFrogg MCP сервера и доступным инструментам.',
    inputSchema: {
      type: 'object',
      properties: {
        tool: {
          type: 'string',
          description: 'Название инструмента для детализации. Оставьте пустым для общего описания.',
        },
        output: outputSchema,
        store_as: { type: ['string', 'object'] },
        store_scope: { type: 'string', enum: ['session', 'persistent'] },
        span_id: { type: 'string' },
        parent_span_id: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'mcp_state',
    description: 'Session/persistent state store for cross-tool workflows.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['set', 'get', 'list', 'unset', 'clear', 'dump'] },
        key: { type: 'string' },
        value: {},
        scope: { type: 'string', enum: ['session', 'persistent', 'any'] },
        prefix: { type: 'string' },
        include_values: { type: 'boolean' },
        output: outputSchema,
        store_as: { type: ['string', 'object'] },
        store_scope: { type: 'string', enum: ['session', 'persistent'] },
        trace_id: { type: 'string' },
        span_id: { type: 'string' },
        parent_span_id: { type: 'string' },
        preset: { type: 'string' },
        preset_name: { type: 'string' },
      },
      required: ['action'],
      additionalProperties: true,
    },
  },
  {
    name: 'mcp_project',
    description: 'Project registry: bind SSH/env profiles to named projects + manage active project.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['project_upsert', 'project_get', 'project_list', 'project_delete', 'project_use', 'project_active', 'project_unuse'] },
        name: { type: 'string' },
        project: { type: 'object' },
        description: { type: 'string' },
        default_target: { type: 'string' },
        targets: { type: 'object' },
        scope: { type: 'string', enum: ['session', 'persistent', 'any'] },
        output: outputSchema,
        store_as: { type: ['string', 'object'] },
        store_scope: { type: 'string', enum: ['session', 'persistent'] },
        trace_id: { type: 'string' },
        span_id: { type: 'string' },
        parent_span_id: { type: 'string' },
        preset: { type: 'string' },
        preset_name: { type: 'string' },
      },
      required: ['action'],
      additionalProperties: true,
    },
  },
  {
    name: 'mcp_env',
    description: 'Encrypted env bundles + safe remote apply via SSH/SFTP.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['profile_upsert', 'profile_get', 'profile_list', 'profile_delete', 'write_remote', 'run_remote'] },
        profile_name: { type: 'string' },
        include_secrets: { type: 'boolean' },
        description: { type: 'string' },
        variables: { type: 'object' },
        env: { type: 'object' },
        data: { type: 'object' },
        secrets: { type: ['object', 'null'] },

        project: { type: 'string' },
        target: { type: 'string' },
        ssh_profile_name: { type: 'string' },
        ssh_profile: { type: 'string' },

        remote_path: { type: 'string' },
        mode: { type: 'integer' },
        mkdirs: { type: 'boolean' },
        overwrite: { type: 'boolean' },
        backup: { type: 'boolean' },

        command: { type: 'string' },
        cwd: { type: 'string' },
        stdin: { type: 'string' },
        timeout_ms: { type: 'integer' },
        pty: { type: ['boolean', 'object'] },

        output: outputSchema,
        store_as: { type: ['string', 'object'] },
        store_scope: { type: 'string', enum: ['session', 'persistent'] },
        trace_id: { type: 'string' },
        span_id: { type: 'string' },
        parent_span_id: { type: 'string' },
        preset: { type: 'string' },
        preset_name: { type: 'string' },
      },
      required: ['action'],
      additionalProperties: true,
    },
  },
  {
    name: 'mcp_runbook',
    description: 'Runbooks: store, list, and execute multi-step workflows.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['runbook_upsert', 'runbook_upsert_dsl', 'runbook_get', 'runbook_list', 'runbook_delete', 'runbook_run', 'runbook_run_dsl', 'runbook_compile'] },
        name: { type: 'string' },
        runbook: { type: 'object' },
        dsl: { type: 'string' },
        text: { type: 'string' },
        input: { type: 'object' },
        seed_state: { type: 'object' },
        seed_state_scope: { type: 'string', enum: ['session', 'persistent'] },
        stop_on_error: { type: 'boolean' },
        template_missing: { type: 'string', enum: ['error', 'empty', 'null', 'undefined'] },
        output: outputSchema,
        store_as: { type: ['string', 'object'] },
        store_scope: { type: 'string', enum: ['session', 'persistent'] },
        trace_id: { type: 'string' },
        span_id: { type: 'string' },
        parent_span_id: { type: 'string' },
        preset: { type: 'string' },
        preset_name: { type: 'string' },
      },
      required: ['action'],
      additionalProperties: true,
    },
  },
  {
    name: 'mcp_alias',
    description: 'Alias registry for short names and reusable tool shortcuts.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['alias_upsert', 'alias_get', 'alias_list', 'alias_delete', 'alias_resolve'] },
        name: { type: 'string' },
        alias: { type: 'object' },
        tool: { type: 'string' },
        args: { type: 'object' },
        preset: { type: 'string' },
        description: { type: 'string' },
        output: outputSchema,
        store_as: { type: ['string', 'object'] },
        store_scope: { type: 'string', enum: ['session', 'persistent'] },
        trace_id: { type: 'string' },
        span_id: { type: 'string' },
        parent_span_id: { type: 'string' },
      },
      required: ['action'],
      additionalProperties: true,
    },
  },
  {
    name: 'mcp_preset',
    description: 'Preset registry for reusable tool arguments.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['preset_upsert', 'preset_get', 'preset_list', 'preset_delete'] },
        tool: { type: 'string' },
        name: { type: 'string' },
        preset: { type: 'object' },
        output: outputSchema,
        store_as: { type: ['string', 'object'] },
        store_scope: { type: 'string', enum: ['session', 'persistent'] },
        trace_id: { type: 'string' },
        span_id: { type: 'string' },
        parent_span_id: { type: 'string' },
      },
      required: ['action'],
      additionalProperties: true,
    },
  },
  {
    name: 'mcp_audit',
    description: 'Audit log access with filtering and tail support.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['audit_list', 'audit_tail', 'audit_clear', 'audit_stats'] },
        limit: { type: 'integer' },
        offset: { type: 'integer' },
        reverse: { type: 'boolean' },
        trace_id: { type: 'string' },
        tool: { type: 'string' },
        audit_action: { type: 'string' },
        status: { type: 'string', enum: ['ok', 'error'] },
        since: { type: 'string' },
        output: outputSchema,
        store_as: { type: ['string', 'object'] },
        store_scope: { type: 'string', enum: ['session', 'persistent'] },
        trace_id: { type: 'string' },
        span_id: { type: 'string' },
        parent_span_id: { type: 'string' },
      },
      required: ['action'],
      additionalProperties: true,
    },
  },
  {
    name: 'mcp_pipeline',
    description: 'Streaming pipelines between HTTP, SFTP, and PostgreSQL.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['run', 'describe'] },
        flow: { type: 'string', enum: ['http_to_sftp', 'sftp_to_http', 'http_to_postgres', 'sftp_to_postgres', 'postgres_to_sftp', 'postgres_to_http'] },
        project: { type: 'string' },
        target: { type: 'string' },
        http: { type: 'object' },
        sftp: { type: 'object' },
        postgres: { type: 'object' },
        format: { type: 'string', enum: ['jsonl', 'csv'] },
        batch_size: { type: 'integer' },
        max_rows: { type: 'integer' },
        limit: { type: 'integer' },
        offset: { type: 'integer' },
        columns: { type: 'array', items: { type: 'string' } },
        columns_sql: { type: 'string' },
        order_by: { type: 'array' },
        order_by_sql: { type: 'string' },
        filters: { type: 'object' },
        where_sql: { type: 'string' },
        where_params: { type: 'array' },
        timeout_ms: { type: 'integer' },
        csv_header: { type: 'boolean' },
        csv_delimiter: { type: 'string' },
        cache: { type: 'object' },
        output: outputSchema,
        store_as: { type: ['string', 'object'] },
        store_scope: { type: 'string', enum: ['session', 'persistent'] },
        trace_id: { type: 'string' },
        span_id: { type: 'string' },
        parent_span_id: { type: 'string' },
        preset: { type: 'string' },
        preset_name: { type: 'string' },
      },
      required: ['action'],
      additionalProperties: true,
    },
  },
  {
    name: 'mcp_psql_manager',
    description: 'PostgreSQL toolchain. Profile actions + query/batch/transaction + CRUD + select/count/exists/export helpers.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['profile_upsert', 'profile_get', 'profile_list', 'profile_delete', 'profile_test', 'query', 'batch', 'transaction', 'insert', 'insert_bulk', 'update', 'delete', 'select', 'count', 'exists', 'export', 'catalog_tables', 'catalog_columns', 'database_info'] },
        profile_name: { type: 'string' },
        include_secrets: { type: 'boolean' },
        connection: { type: 'object' },
        connection_url: { type: 'string' },
        project: { type: 'string' },
        target: { type: 'string' },
        pool: { type: 'object' },
        options: { type: 'object' },
        sql: { type: 'string' },
        params: { type: 'array', items: { type: ['string', 'number', 'boolean', 'null'] } },
        mode: { type: 'string', enum: ['rows', 'row', 'value', 'command'] },
        timeout_ms: { type: 'integer' },
        statements: { type: 'array', items: { type: 'object' } },
        transactional: { type: 'boolean' },
        table: { type: 'string' },
        schema: { type: 'string' },
        columns: { type: ['array', 'string'] },
        columns_sql: { type: 'string' },
        order_by: { type: ['array', 'object', 'string'] },
        order_by_sql: { type: 'string' },
        limit: { type: 'integer' },
        offset: { type: 'integer' },
        data: { type: 'object' },
        rows: { type: 'array' },
        filters: { type: ['object', 'array'] },
        where_sql: { type: 'string' },
        where_params: { type: 'array', items: { type: ['string', 'number', 'boolean', 'null'] } },
        returning: { type: ['boolean', 'array', 'string'] },
        file_path: { type: 'string' },
        overwrite: { type: 'boolean' },
        format: { type: 'string', enum: ['csv', 'jsonl'] },
        batch_size: { type: 'integer' },
        output: outputSchema,
        store_as: { type: ['string', 'object'] },
        store_scope: { type: 'string', enum: ['session', 'persistent'] },
        trace_id: { type: 'string' },
        span_id: { type: 'string' },
        parent_span_id: { type: 'string' },
        preset: { type: 'string' },
        preset_name: { type: 'string' },
      },
      required: ['action'],
      additionalProperties: true
    }
  },
  {
    name: 'mcp_ssh_manager',
    description: 'SSH executor with profiles, exec/batch diagnostics, and SFTP helpers.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['profile_upsert', 'profile_get', 'profile_list', 'profile_delete', 'profile_test', 'exec', 'batch', 'system_info', 'check_host', 'sftp_list', 'sftp_upload', 'sftp_download'] },
        profile_name: { type: 'string' },
        include_secrets: { type: 'boolean' },
        connection: { type: 'object' },
        project: { type: 'string' },
        target: { type: 'string' },
        command: { type: 'string' },
        cwd: { type: 'string' },
        env: { type: 'object' },
        stdin: { type: 'string' },
        timeout_ms: { type: 'integer' },
        pty: { type: ['boolean', 'object'] },
        commands: { type: 'array', items: { type: 'object' } },
        parallel: { type: 'boolean' },
        stop_on_error: { type: 'boolean' },
        path: { type: 'string' },
        remote_path: { type: 'string' },
        local_path: { type: 'string' },
        recursive: { type: 'boolean' },
        max_depth: { type: 'integer' },
        overwrite: { type: 'boolean' },
        mkdirs: { type: 'boolean' },
        preserve_mtime: { type: 'boolean' },
        output: outputSchema,
        store_as: { type: ['string', 'object'] },
        store_scope: { type: 'string', enum: ['session', 'persistent'] },
        trace_id: { type: 'string' },
        span_id: { type: 'string' },
        parent_span_id: { type: 'string' },
        preset: { type: 'string' },
        preset_name: { type: 'string' },
      },
      required: ['action'],
      additionalProperties: true
    }
  },
  {
    name: 'mcp_api_client',
    description: 'HTTP client with profiles, auth providers, retry/backoff, pagination, and downloads.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['profile_upsert', 'profile_get', 'profile_list', 'profile_delete', 'request', 'paginate', 'download', 'check'] },
        profile_name: { type: 'string' },
        include_secrets: { type: 'boolean' },
        project: { type: 'string' },
        target: { type: 'string' },
        base_url: { type: 'string' },
        url: { type: 'string' },
        path: { type: 'string' },
        query: { type: ['object', 'string'] },
        method: { type: 'string' },
        headers: { type: 'object' },
        auth: { type: ['string', 'object'] },
        auth_provider: { type: 'object' },
        body: { type: ['object', 'string', 'number', 'boolean', 'null'] },
        data: { type: ['object', 'string', 'number', 'boolean', 'null'] },
        body_type: { type: 'string' },
        body_base64: { type: 'string' },
        form: { type: 'object' },
        timeout_ms: { type: 'integer' },
        response_type: { type: 'string' },
        redirect: { type: 'string' },
        retry: { type: 'object' },
        pagination: { type: 'object' },
        cache: { type: ['boolean', 'object'] },
        download_path: { type: 'string' },
        overwrite: { type: 'boolean' },
        output: outputSchema,
        store_as: { type: ['string', 'object'] },
        store_scope: { type: 'string', enum: ['session', 'persistent'] },
        trace_id: { type: 'string' },
        span_id: { type: 'string' },
        parent_span_id: { type: 'string' },
        preset: { type: 'string' },
        preset_name: { type: 'string' },
      },
      required: ['action'],
      additionalProperties: true
    }
  }
];

if (isUnsafeLocalEnabled()) {
  toolCatalog.push({
    name: 'mcp_local',
    description: 'UNSAFE local machine access: exec and filesystem helpers (requires SENTRYFROGG_UNSAFE_LOCAL=1).',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['exec', 'batch', 'fs_read', 'fs_write', 'fs_list', 'fs_stat', 'fs_mkdir', 'fs_rm'] },
        command: { type: 'string' },
        args: { type: 'array' },
        shell: { type: ['boolean', 'string'] },
        cwd: { type: 'string' },
        env: { type: 'object' },
        stdin: { type: 'string' },
        timeout_ms: { type: 'integer' },
        inline: { type: 'boolean' },
        commands: { type: 'array', items: { type: 'object' } },
        parallel: { type: 'boolean' },
        stop_on_error: { type: 'boolean' },
        path: { type: 'string' },
        encoding: { type: 'string' },
        offset: { type: 'integer' },
        length: { type: 'integer' },
        content: {},
        content_base64: { type: 'string' },
        overwrite: { type: 'boolean' },
        mode: { type: 'integer' },
        recursive: { type: 'boolean' },
        max_depth: { type: 'integer' },
        with_stats: { type: 'boolean' },
        force: { type: 'boolean' },
        output: outputSchema,
        store_as: { type: ['string', 'object'] },
        store_scope: { type: 'string', enum: ['session', 'persistent'] },
        trace_id: { type: 'string' },
        span_id: { type: 'string' },
        parent_span_id: { type: 'string' },
        preset: { type: 'string' },
        preset_name: { type: 'string' },
      },
      required: ['action'],
      additionalProperties: true,
    },
  });
}

const toolByName = Object.fromEntries(toolCatalog.map((tool) => [tool.name, tool]));
toolCatalog.push(
  { name: 'sql', description: 'Alias for mcp_psql_manager.', inputSchema: toolByName.mcp_psql_manager.inputSchema },
  { name: 'psql', description: 'Alias for mcp_psql_manager.', inputSchema: toolByName.mcp_psql_manager.inputSchema },
  { name: 'ssh', description: 'Alias for mcp_ssh_manager.', inputSchema: toolByName.mcp_ssh_manager.inputSchema },
  { name: 'http', description: 'Alias for mcp_api_client.', inputSchema: toolByName.mcp_api_client.inputSchema },
  { name: 'api', description: 'Alias for mcp_api_client.', inputSchema: toolByName.mcp_api_client.inputSchema },
  { name: 'state', description: 'Alias for mcp_state.', inputSchema: toolByName.mcp_state.inputSchema },
  { name: 'project', description: 'Alias for mcp_project.', inputSchema: toolByName.mcp_project.inputSchema },
  { name: 'env', description: 'Alias for mcp_env.', inputSchema: toolByName.mcp_env.inputSchema },
  { name: 'runbook', description: 'Alias for mcp_runbook.', inputSchema: toolByName.mcp_runbook.inputSchema },
  { name: 'alias', description: 'Alias for mcp_alias.', inputSchema: toolByName.mcp_alias.inputSchema },
  { name: 'preset', description: 'Alias for mcp_preset.', inputSchema: toolByName.mcp_preset.inputSchema },
  { name: 'audit', description: 'Alias for mcp_audit.', inputSchema: toolByName.mcp_audit.inputSchema },
  { name: 'pipeline', description: 'Alias for mcp_pipeline.', inputSchema: toolByName.mcp_pipeline.inputSchema }
);

if (toolByName.mcp_local) {
  toolCatalog.push({ name: 'local', description: 'Alias for mcp_local.', inputSchema: toolByName.mcp_local.inputSchema });
}

class SentryFroggServer {
  constructor() {
    this.server = new Server(
      {
        name: 'sentryfrogg',
        version: '6.4.0',
      },
      {
        capabilities: {
          tools: { list: true, call: true },
        },
        protocolVersion: '2025-06-18',
      }
    );
    this.container = null;
    this.initialized = false;
  }

  async initialize() {
    try {
      this.container = await ServiceBootstrap.initialize();
      await this.setupHandlers();
      this.initialized = true;
      const logger = this.container.get('logger');
      logger.info('SentryFrogg MCP Server v6.4.0 ready');
    } catch (error) {
      process.stderr.write(`Failed to initialize SentryFrogg MCP Server: ${error.message}\n`);
      throw error;
    }
  }

  async setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolCatalog }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const toolExecutor = this.container.get('toolExecutor');

      try {
        let result;
        let payload;
        const startedAt = Date.now();
        switch (name) {
          case 'help': {
            const traceId = args?.trace_id || crypto.randomUUID();
            const spanId = args?.span_id || crypto.randomUUID();
            const parentSpanId = args?.parent_span_id;
            result = this.handleHelp(args);
            payload = await toolExecutor.wrapResult({
              tool: name,
              args,
              result,
              startedAt,
              traceId,
              spanId,
              parentSpanId,
            });
            break;
          }
          default:
            payload = await toolExecutor.execute(name, args);
            break;
        }

        return {
          content: [
            {
              type: 'text',
              text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2),
            },
          ],
        };
      } catch (error) {
        const logger = this.container?.get('logger');
        logger?.error('Tool execution failed', {
          tool: name,
          action: args?.action,
          error: error.message,
        });

        throw new McpError(ErrorCode.InternalError, `Ошибка выполнения ${name}: ${error.message}`);
      }
    });
  }

  async handlePostgreSQL(args) {
    this.ensureInitialized();
    return this.container.get('postgresqlManager').handleAction(args);
  }

  async handleSSH(args) {
    this.ensureInitialized();
    return this.container.get('sshManager').handleAction(args);
  }

  async handleAPI(args) {
    this.ensureInitialized();
    return this.container.get('apiManager').handleAction(args);
  }

  handleHelp(args = {}) {
    this.ensureInitialized();
    const tool = args.tool?.toLowerCase();
    const summaries = {
      help: {
        description: 'Показывает справку. Передайте `tool`, чтобы получить детали по инструменту.',
        usage: "call_tool → name: 'help', arguments: { tool?: string }",
      },
      mcp_psql_manager: {
        description: 'PostgreSQL: профили, запросы, транзакции, CRUD, select/count/exists/export + bulk insert.',
        usage: "profile_upsert/profile_list → query/batch/transaction → insert/insert_bulk/update/delete/select/count/exists/export",
      },
      mcp_ssh_manager: {
        description: 'SSH: профили, exec/batch, диагностика и SFTP.',
        usage: "profile_upsert/profile_list → exec/batch/system_info/check_host/sftp_*",
      },
      mcp_api_client: {
        description: 'HTTP: профили, request/paginate/download, retry/backoff, auth providers + cache.',
        usage: "profile_upsert/profile_list → request/paginate/download/check",
      },
      mcp_state: {
        description: 'State: переменные между вызовами, поддержка session/persistent.',
        usage: 'set/get/list/unset/clear/dump',
      },
      mcp_project: {
        description: 'Projects: привязка SSH/env профилей к проектам и выбор активного проекта.',
        usage: 'project_upsert/project_list → project_use → (ssh/env без явного profile_name)',
      },
      mcp_env: {
        description: 'Env: зашифрованные env-бандлы и безопасная запись/запуск на серверах по SSH.',
        usage: 'profile_upsert/profile_list → write_remote/run_remote',
      },
      mcp_runbook: {
        description: 'Runbooks: хранение и выполнение многошаговых сценариев, плюс DSL.',
        usage: 'runbook_upsert/runbook_upsert_dsl/runbook_list → runbook_run/runbook_run_dsl',
      },
      mcp_alias: {
        description: 'Aliases: короткие имена для инструментов и аргументов.',
        usage: 'alias_upsert/alias_list/alias_get/alias_delete',
      },
      mcp_preset: {
        description: 'Presets: reusable наборы аргументов для инструментов.',
        usage: 'preset_upsert/preset_list/preset_get/preset_delete',
      },
      mcp_audit: {
        description: 'Audit log: просмотр и фильтрация событий.',
        usage: 'audit_list/audit_tail/audit_stats/audit_clear',
      },
      mcp_pipeline: {
        description: 'Pipelines: потоковые HTTP↔SFTP↔PostgreSQL сценарии.',
        usage: 'run/describe',
      },
    };

    if (isUnsafeLocalEnabled()) {
      summaries.mcp_local = {
        description: 'Local (UNSAFE): локальные exec и filesystem операции (только при включённом unsafe режиме).',
        usage: 'exec/batch/fs_read/fs_write/fs_list/fs_stat/fs_mkdir/fs_rm',
      };
    }

    if (tool && summaries[tool]) {
      return summaries[tool];
    }

    return {
      overview: isUnsafeLocalEnabled()
        ? 'SentryFrogg MCP подключает PostgreSQL, SSH, HTTP, state, runbook, alias, preset, audit, pipeline и (unsafe) local инструменты. Можно использовать профиль или inline-подключение в каждом вызове.'
        : 'SentryFrogg MCP подключает PostgreSQL, SSH, HTTP, state, runbook, alias, preset, audit и pipeline инструменты. Можно использовать профиль или inline-подключение в каждом вызове.',
      tools: Object.entries(summaries).map(([key, value]) => ({
        name: key,
        description: value.description,
        usage: value.usage,
      })),
    };
  }

  ensureInitialized() {
    if (!this.initialized) {
      throw new Error('SentryFrogg MCP Server not initialized');
    }
  }

  async run() {
    await this.initialize();

    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    const cleanup = async () => {
      try {
        await ServiceBootstrap.cleanup();
        process.exit(0);
      } catch (error) {
        process.stderr.write(`Cleanup failed: ${error.message}\n`);
        process.exit(1);
      }
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
    process.on('uncaughtException', (error) => {
      process.stderr.write(`Uncaught exception: ${error.message}\n`);
      cleanup();
    });
  }

  getStats() {
    if (!this.initialized) {
      return { error: 'Server not initialized' };
    }

    return {
      version: '6.4.0',
      architecture: 'lightweight-service-layer',
      ...ServiceBootstrap.getStats(),
    };
  }
}

if (require.main === module) {
  const server = new SentryFroggServer();
  server.run().catch((error) => {
    process.stderr.write(`Server run failed: ${error.message}\n`);
    process.exit(1);
  });
}

module.exports = SentryFroggServer;
