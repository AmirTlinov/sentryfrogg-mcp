#!/usr/bin/env node

/**
 * 📝 Минимальный логгер для MCP сервера
 * Упрощён до консольного вывода, чтобы снизить когнитивную нагрузку.
 */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const DEFAULT_LEVEL = process.env.LOG_LEVEL?.toLowerCase() || 'info';

class Logger {
  constructor(context = 'sentryfrogg', level = DEFAULT_LEVEL) {
    this.context = context;
    this.level = LEVELS[level] !== undefined ? level : 'info';
    this.counters = { error: 0, warn: 0, info: 0, debug: 0 };
  }

  shouldLog(level) {
    return LEVELS[level] <= LEVELS[this.level];
  }

  log(level, message, meta) {
    if (!this.shouldLog(level)) {
      return;
    }

    this.counters[level] += 1;
    const timestamp = new Date().toISOString();
    const metaSuffix = meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
    const line = `[${timestamp}] ${level.toUpperCase()} [${this.context}] ${message}${metaSuffix}`;

    process.stderr.write(`${line}\n`);
  }

  error(message, meta = {}) {
    this.log('error', message, meta);
  }

  warn(message, meta = {}) {
    this.log('warn', message, meta);
  }

  info(message, meta = {}) {
    this.log('info', message, meta);
  }

  debug(message, meta = {}) {
    this.log('debug', message, meta);
  }

  child(suffix) {
    const childContext = suffix ? `${this.context}:${suffix}` : this.context;
    return new Logger(childContext, this.level);
  }

  setLevel(level) {
    if (LEVELS[level] !== undefined) {
      this.level = level;
    }
  }

  setContext(context) {
    this.context = context;
  }

  getStats() {
    return { level: this.level, context: this.context, ...this.counters };
  }
}

module.exports = Logger;
