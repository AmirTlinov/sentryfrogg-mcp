#!/usr/bin/env node

const VALID_KINDS = new Set([
  'invalid_params',
  'denied',
  'not_found',
  'conflict',
  'timeout',
  'retryable',
  'internal',
]);

class ToolError extends Error {
  constructor({ kind, code, message, hint, details, retryable } = {}) {
    const safeKind = typeof kind === 'string' ? kind : 'internal';
    const safeCode = typeof code === 'string' && code.trim().length ? code.trim() : 'INTERNAL';
    const safeMessage = typeof message === 'string' && message.trim().length
      ? message.trim()
      : safeCode;

    super(safeMessage);
    this.name = 'ToolError';
    this.kind = VALID_KINDS.has(safeKind) ? safeKind : 'internal';
    this.code = safeCode;
    this.hint = typeof hint === 'string' && hint.trim().length ? hint.trim() : undefined;
    this.details = details && typeof details === 'object' && !Array.isArray(details) ? details : undefined;
    this.retryable = Boolean(retryable);
  }

  toJSON() {
    return {
      name: this.name,
      kind: this.kind,
      code: this.code,
      message: this.message,
      hint: this.hint,
      details: this.details,
      retryable: this.retryable,
    };
  }

  static isToolError(error) {
    return Boolean(error && typeof error === 'object' && error.name === 'ToolError' && typeof error.kind === 'string');
  }

  static invalidParams({ message, field, expected, received, hint, details } = {}) {
    const payload = {
      ...(details && typeof details === 'object' && !Array.isArray(details) ? details : {}),
    };
    if (field !== undefined) {
      payload.field = field;
    }
    if (expected !== undefined) {
      payload.expected = expected;
    }
    if (received !== undefined) {
      payload.received = received;
    }

    return new ToolError({
      kind: 'invalid_params',
      code: 'INVALID_PARAMS',
      message: message || 'Invalid parameters',
      hint,
      details: Object.keys(payload).length ? payload : undefined,
      retryable: false,
    });
  }

  static denied({ code, message, hint, details, retryable } = {}) {
    return new ToolError({
      kind: 'denied',
      code: code || 'DENIED',
      message: message || 'Request denied',
      hint,
      details,
      retryable: Boolean(retryable),
    });
  }

  static notFound({ code, message, hint, details, retryable } = {}) {
    return new ToolError({
      kind: 'not_found',
      code: code || 'NOT_FOUND',
      message: message || 'Not found',
      hint,
      details,
      retryable: Boolean(retryable),
    });
  }

  static conflict({ code, message, hint, details, retryable } = {}) {
    return new ToolError({
      kind: 'conflict',
      code: code || 'CONFLICT',
      message: message || 'Conflict',
      hint,
      details,
      retryable: Boolean(retryable),
    });
  }

  static timeout({ code, message, hint, details } = {}) {
    return new ToolError({
      kind: 'timeout',
      code: code || 'TIMEOUT',
      message: message || 'Timed out',
      hint,
      details,
      retryable: true,
    });
  }

  static retryable({ code, message, hint, details } = {}) {
    return new ToolError({
      kind: 'retryable',
      code: code || 'RETRYABLE',
      message: message || 'Retryable error',
      hint,
      details,
      retryable: true,
    });
  }

  static internal({ code, message, hint, details, retryable } = {}) {
    return new ToolError({
      kind: 'internal',
      code: code || 'INTERNAL',
      message: message || 'Internal error',
      hint,
      details,
      retryable: Boolean(retryable),
    });
  }
}

module.exports = ToolError;
