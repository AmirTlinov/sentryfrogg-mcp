#!/usr/bin/env node
// @ts-nocheck

function normalizeIdentifierPart(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) {
    throw new Error('Identifier must be a non-empty string');
  }
  if (trimmed.includes('\0')) {
    throw new Error('Identifier must not contain null bytes');
  }
  const unquoted = trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1)
    : trimmed;
  return `"${unquoted.replace(/"/g, '""')}"`;
}

function quoteQualifiedIdentifier(identifier) {
  const parts = String(identifier ?? '').split('.');
  if (parts.length === 0) {
    throw new Error('Identifier must be a non-empty string');
  }
  return parts.map(normalizeIdentifierPart).join('.');
}

function normalizeTableContext(tableName, schemaName) {
  if (!tableName) {
    throw new Error('Table name is required');
  }

  if (schemaName) {
    const schema = String(schemaName);
    const table = String(tableName);
    return {
      schema,
      table,
      qualified: `${normalizeIdentifierPart(schema)}.${normalizeIdentifierPart(table)}`,
    };
  }

  return {
    schema: undefined,
    table: String(tableName),
    qualified: quoteQualifiedIdentifier(tableName),
  };
}

function buildFiltersClause(filters, startIndex = 1) {
  const clauses = [];
  const values = [];
  let index = startIndex;

  const addValue = (value) => {
    values.push(value);
    const placeholder = `$${index}`;
    index += 1;
    return placeholder;
  };

  const normalizeOperator = (op) => String(op || '=').trim().toUpperCase();

  const pushFilter = (column, op, value) => {
    const columnSql = quoteQualifiedIdentifier(column);
    const operator = normalizeOperator(op);

    if (value === null) {
      if (operator === '!=' || operator === '<>') {
        clauses.push(`${columnSql} IS NOT NULL`);
        return;
      }
      clauses.push(`${columnSql} IS NULL`);
      return;
    }

    if (operator === 'IN' || operator === 'NOT IN') {
      if (!Array.isArray(value) || value.length === 0) {
        throw new Error(`${operator} filter requires a non-empty array`);
      }
      const placeholders = value.map((entry) => addValue(entry)).join(', ');
      clauses.push(`${columnSql} ${operator} (${placeholders})`);
      return;
    }

    const placeholder = addValue(value);
    clauses.push(`${columnSql} ${operator} ${placeholder}`);
  };

  if (Array.isArray(filters)) {
    for (const item of filters) {
      if (!item || typeof item !== 'object') {
        throw new Error('Filter item must be an object');
      }
      pushFilter(item.column ?? item.field, item.op, item.value);
    }
  } else if (filters && typeof filters === 'object') {
    for (const [column, value] of Object.entries(filters)) {
      pushFilter(column, '=', value);
    }
  }

  return {
    clause: clauses.join(' AND '),
    params: values,
    nextIndex: index,
  };
}

function buildWhereClause({ filters, whereSql, whereParams, startIndex = 1 } = {}) {
  if (whereSql) {
    return {
      clause: String(whereSql),
      params: Array.isArray(whereParams) ? whereParams : [],
      nextIndex: startIndex + (Array.isArray(whereParams) ? whereParams.length : 0),
    };
  }

  if (filters) {
    return buildFiltersClause(filters, startIndex);
  }

  return { clause: '', params: [], nextIndex: startIndex };
}

module.exports = {
  normalizeIdentifierPart,
  quoteQualifiedIdentifier,
  normalizeTableContext,
  buildWhereClause,
};
