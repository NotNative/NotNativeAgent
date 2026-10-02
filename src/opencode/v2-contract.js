// SPDX-License-Identifier: Apache-2.0
import { newId } from '../ids.js';

export function apiError(status, tag, message, fields = {}) {
  return Object.assign(new Error(message), { httpStatus: status, body: { _tag: tag, message, ...fields } });
}

export function invalid(message) { return apiError(400, 'InvalidRequestError', message); }

export function objectInput(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('Expected a JSON object');
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw invalid(`Unsupported field: ${unknown}`);
  return value;
}

export function textInput(value, name, maximum = 65_536) {
  if (typeof value !== 'string' || value.length > maximum) throw invalid(`${name} must be a string of at most ${maximum} characters`);
  return value;
}

export function wireId(value, prefix) {
  if (value == null) return newId(prefix);
  if (typeof value !== 'string' || !new RegExp(`^${prefix}_[A-Za-z0-9-]{1,128}$`, 'u').test(value)) throw invalid(`Invalid ${prefix} identifier`);
  return value;
}

export function tokenUsage(tokens = {}) {
  return { input: tokens.input ?? 0, output: tokens.output ?? 0, reasoning: tokens.reasoning ?? 0,
    cache: { read: tokens.cache?.read ?? 0, write: tokens.cache?.write ?? 0 } };
}

export function modelReference(config) {
  const source = config?.routes?.primary ?? config?.provider ?? {};
  return { id: source.model ?? 'nna', providerID: source.providerId ?? source.id ?? 'nna' };
}

export function validateSelection(input, model) {
  if (input.agent != null && input.agent !== 'build') throw invalid('This surface supports the build agent only');
  if (input.model != null) {
    objectInput(input.model, ['id', 'providerID']);
    if (input.model.id !== model.id || input.model.providerID !== model.providerID) throw invalid('Select the model configured in NNA');
  }
}

export function paginate(values, query, scope) {
  const limit = query.limit === undefined ? 50 : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw invalid('limit must be an integer from 1 to 500');
  let order = query.order ?? 'desc'; let cursorInput = null;
  if (query.cursor !== undefined) {
    try {
      const cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'));
      if (query.order !== undefined || cursor.scope !== scope || typeof cursor.anchor !== 'string'
        || !['next', 'previous'].includes(cursor.direction)) throw new Error('cursor');
      order = cursor.order; cursorInput = cursor;
    } catch { throw apiError(400, 'InvalidCursorError', 'Invalid pagination cursor'); }
  }
  if (!['asc', 'desc'].includes(order)) throw invalid('order must be asc or desc');
  const sorted = order === 'asc' ? values : [...values].reverse();
  const anchor = cursorInput ? sorted.findIndex((item) => item.id === cursorInput.anchor) : -1;
  if (cursorInput && anchor < 0) throw apiError(400, 'InvalidCursorError', 'The cursor record is no longer available');
  const offset = !cursorInput ? 0 : cursorInput.direction === 'next' ? anchor + 1 : Math.max(0, anchor - limit);
  const end = cursorInput?.direction === 'previous' ? anchor : offset + limit;
  const data = sorted.slice(offset, end);
  const cursor = (item, direction) => Buffer.from(JSON.stringify({ scope, order, anchor: item.id, direction })).toString('base64url');
  return { data, cursor: {
    previous: offset > 0 && data.length ? cursor(data[0], 'previous') : null,
    next: end < sorted.length && data.length ? cursor(data.at(-1), 'next') : null,
  } };
}
