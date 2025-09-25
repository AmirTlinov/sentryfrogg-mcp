#!/usr/bin/env node

/**
 * 🌐 Лёгкий HTTP клиент для MCP
 */

const Constants = require('../constants/Constants.cjs');

let fetchPromise = null;
async function fetchFn(...args) {
  if (!fetchPromise) {
    fetchPromise = import('node-fetch').then((mod) => mod.default);
  }
  const fetch = await fetchPromise;
  return fetch(...args);
}

class APIManager {
  constructor(logger, security, validation) {
    this.logger = logger.child('api');
    this.security = security;
    this.validation = validation;
    this.stats = {
      requests: 0,
      errors: 0,
    };
  }

  async handleAction(args) {
    const { action } = args;

    switch (action) {
      case 'get':
        return this.request('GET', args.url, args);
      case 'post':
        return this.request('POST', args.url, args);
      case 'put':
        return this.request('PUT', args.url, args);
      case 'delete':
        return this.request('DELETE', args.url, args);
      case 'patch':
        return this.request('PATCH', args.url, args);
      case 'check_api':
        return this.checkApi(args.url, args);
      default:
        throw new Error(`Unknown API action: ${action}`);
    }
  }

  buildHeaders(rawHeaders, authToken, hasBody) {
    const headers = this.validation.ensureHeaders(rawHeaders);
    const finalHeaders = {
      'User-Agent': 'mcp-api-client/4.2.0',
      Accept: 'application/json, text/plain, */*',
      ...headers,
    };

    if (authToken) {
      finalHeaders.Authorization = authToken.startsWith('Bearer ')
        ? authToken
        : `Bearer ${authToken}`;
    }

    if (hasBody && !finalHeaders['Content-Type'] && !finalHeaders['content-type']) {
      finalHeaders['Content-Type'] = 'application/json';
    }

    return finalHeaders;
  }

  async request(method, url, { data, headers, auth_token }) {
    const parsedUrl = this.security.ensureUrl(url);
    const body = data !== undefined ? JSON.stringify(data) : undefined;
    const hasBody = body !== undefined && body.length > 0;
    const finalHeaders = this.buildHeaders(headers, auth_token, hasBody);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Constants.NETWORK.TIMEOUT_SSH_COMMAND);

    try {
      const response = await fetchFn(parsedUrl.toString(), {
        method,
        headers: finalHeaders,
        body,
        signal: controller.signal,
      });

      const contentType = response.headers.get('content-type') || '';
      let payload;

      if (contentType.includes('application/json')) {
        try {
          payload = await response.json();
        } catch (error) {
          payload = await response.text();
        }
      } else {
        payload = await response.text();
      }

      this.stats.requests += 1;

      return {
        success: response.ok,
        method,
        url: parsedUrl.toString(),
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        data: payload,
      };
    } catch (error) {
      this.stats.errors += 1;
      this.logger.error('HTTP request failed', { method, url: parsedUrl.toString(), error: error.message });
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async checkApi(url, params = {}) {
    try {
      const result = await this.request('GET', url, params);
      return {
        success: true,
        accessible: result.status < 500,
        status: result.status,
        response: result.data,
      };
    } catch (error) {
      return {
        success: false,
        accessible: false,
        error: error.message,
      };
    }
  }

  getStats() {
    return { ...this.stats };
  }

  async cleanup() {
    // нет ресурсов для очистки
  }
}

module.exports = APIManager;
