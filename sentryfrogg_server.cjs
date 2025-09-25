#!/usr/bin/env node

// SentryFrogg MCP Server v4.2

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

const ServiceBootstrap = require('./src/bootstrap/ServiceBootstrap.cjs');

const toolCatalog = [
  {
    name: 'mcp_psql_manager',
    description: '🐘 PostgreSQL manager: setup_profile · list_profiles · quick_query · show_tables · describe_table · sample_data · insert_data · update_data · delete_data · database_info',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['setup_profile', 'list_profiles', 'quick_query', 'show_tables', 'describe_table', 'sample_data', 'insert_data', 'update_data', 'delete_data', 'database_info'] },
        profile_name: { type: 'string', description: "Profile name (defaults to 'default')" },
        connection_url: { type: 'string', description: 'postgres://user:pass@host:port/db url' },
        host: { type: 'string' },
        port: { type: 'integer' },
        username: { type: 'string' },
        password: { type: 'string' },
        database: { type: 'string' },
        ssl: { type: ['boolean', 'object'] },
        ssl_mode: { type: 'string', description: 'disable | require | verify-ca | verify-full' },
        ssl_ca: { type: 'string', description: 'PEM encoded certificate authority chain' },
        ssl_cert: { type: 'string', description: 'PEM encoded client certificate' },
        ssl_key: { type: 'string', description: 'PEM encoded client private key' },
        ssl_passphrase: { type: 'string', description: 'Optional passphrase for the private key' },
        ssl_servername: { type: 'string', description: 'Override servername for TLS verification' },
        ssl_reject_unauthorized: { type: ['boolean', 'string'], description: 'Set to false to trust self-signed certificates' },
        sql: { type: 'string' },
        params: { type: 'array', items: { type: ['string', 'number', 'boolean', 'null'] } },
        table_name: { type: 'string' },
        data: { type: 'object' },
        where: { type: 'string' },
        limit: { type: 'integer' }
      },
      required: ['action']
    }
  },
  {
    name: 'mcp_ssh_manager',
    description: '🔐 SSH manager: setup_profile · list_profiles · execute · system_info · check_host (password or private_key)',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['setup_profile', 'list_profiles', 'execute', 'system_info', 'check_host'] },
        profile_name: { type: 'string', description: "Profile name (defaults to 'default')" },
        host: { type: 'string' },
        port: { type: 'integer' },
        username: { type: 'string' },
        password: { type: 'string' },
        private_key: { type: 'string', description: 'PEM encoded private key' },
        passphrase: { type: 'string' },
        ready_timeout: { type: 'integer' },
        keepalive_interval: { type: 'integer' },
        command: { type: 'string' }
      },
      required: ['action']
    }
  },
  {
    name: 'mcp_api_client',
    description: '🌐 HTTP client: get · post · put · delete · patch · check_api (accepts local URLs)',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'post', 'put', 'delete', 'patch', 'check_api'] },
        url: { type: 'string' },
        data: { type: 'object' },
        headers: { type: 'object' },
        auth_token: { type: 'string' }
      },
      required: ['action']
    }
  }
];

class SentryFroggServer {
  constructor() {
    this.server = new Server(
      {
        name: 'sentryfrogg',
        version: '4.2.0',
      },
      {
        capabilities: {
          tools: {},
        },
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
      logger.info('SentryFrogg MCP Server v4.2.0 ready');
    } catch (error) {
      process.stderr.write(`Failed to initialize SentryFrogg MCP Server: ${error.message}\n`);
      throw error;
    }
  }

  async setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolCatalog }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        let result;
        switch (name) {
          case 'mcp_psql_manager':
            result = await this.handlePostgreSQL(args);
            break;
          case 'mcp_ssh_manager':
            result = await this.handleSSH(args);
            break;
          case 'mcp_api_client':
            result = await this.handleAPI(args);
            break;
          default:
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        }

        return {
          content: [
            {
              type: 'text',
              text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
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
      version: '4.2.0',
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
