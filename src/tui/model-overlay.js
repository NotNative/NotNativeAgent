// SPDX-License-Identifier: Apache-2.0
import { createMenuOverlay } from './surface-engine.js';

// Why: an observed value is what the endpoint's model card proved; a configured value is what the
// operator entered; an unknown value is neither. The label keeps those three apart instead of
// presenting a guestimate as a measurement.
export function contextTierLabel(row) {
  if (Number.isSafeInteger(row?.context_limit_tokens)) return `${row.context_limit_tokens.toLocaleString('en-US')} ctx`;
  if (Number.isSafeInteger(row?.context_limit_bytes)) {
    return `${Math.round(row.context_limit_bytes / 4).toLocaleString('en-US')} ctx (configured)`;
  }
  return 'ctx unknown';
}

// Why: one sweep answers "which models can I reach" across every connection, so this overlay presents
// each row as a connection and model pair with its reachability and known context window.
export function modelOverlay(engine, models = [], options = {}) {
  const active = engine.config.routes.primary;
  const profile = engine.config.connectionRecords[active.providerId];
  const endpoint = profile?.endpoint ?? active.providerId;
  const providerDefault = profile?.model ?? '--';
  const rows = (options.rows ?? []).filter((row) => typeof row?.model === 'string' && row.model.length > 0);
  const lines = [
    'Choose the model for this conversation.',
    '',
    ...(rows.length > 0 ? [] : [`Provider  ${endpoint}`]),
    `Current   ${active.model}`,
    `Default   ${providerDefault}`,
    '',
    rows.length > 0
      ? `Available models · ${new Set(rows.map((row) => row.connection_id)).size} connection(s)`
      : 'No model catalog was returned; use /model NAME.',
  ];
  if (options.discoveryError) lines.push(`Discovery unavailable: ${options.discoveryError}`);
  const items = [];
  if (options.inheritRoute) items.push({
    id: 'inherit', label: `Copy Main — ${options.inheritRoute.model}`,
    detail: `Copy ${engine.config.connectionRecords[options.inheritRoute.providerId]?.endpoint ?? options.inheritRoute.providerId} once`,
  });
  if (rows.length > 0) {
    for (const row of rows) {
      const badges = [row.connection_name ?? row.connection_id];
      if (row.model === active.model) badges.push('current');
      if (row.model === providerDefault) badges.push('default');
      if (row.status !== 'observed') badges.push(row.status === 'unavailable'
        ? `unavailable${row.reason_code ? ` · ${row.reason_code}` : ''}` : row.status);
      if (Number.isSafeInteger(row.context_limit_tokens)) badges.push(`${row.context_limit_tokens.toLocaleString('en-US')} ctx`);
      else if (row.status === 'observed') badges.push(contextTierLabel(row));
      items.push({ id: `${row.connection_id}/${row.model}`, label: row.model, badge: badges.join(' · '),
        value: { providerId: row.connection_id, model: row.model } });
    }
  } else {
    for (const model of models) {
      const badges = [];
      if (model === active.model) badges.push('current');
      if (model === providerDefault) badges.push('default');
      items.push({ id: model, label: model, badge: badges.join(' · ') });
    }
  }
  return Object.freeze({
    ...createMenuOverlay('model', 'Model', lines, items, { activeId: `${active.providerId}/${active.model}` }),
    actionLabel: 'Up/Down choose · Enter use model',
  });
}
