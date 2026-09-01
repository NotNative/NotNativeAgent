// SPDX-License-Identifier: Apache-2.0
import { paint, TUI_THEME } from './theme.js';
import { wrapIndentedTerminalLine } from './terminal-markdown.js';

const ALLOW_ONCE = 'allow_once';
const DENY = 'deny';
const CANCEL = 'cancel';
const DEFAULT_PERMISSION_CHOICES = Object.freeze([
  ALLOW_ONCE, 'allow_session', 'allow_workspace', DENY, CANCEL,
]);

export function permissionControlLine(permission, bindings) {
  if (isOneShot(permission)) return 'Awaiting your decision';
  const labels = {
    allow_once: `${keyLabel(bindings.allow_once)} allow once`,
    allow_session: 'allow for same operation',
    allow_workspace: 'allow this tool in workspace',
    deny: `${keyLabel(bindings.deny)} deny`, cancel: `${keyLabel(bindings.cancel)} cancel`,
  };
  return choicesFor(permission).map((choice, index) => `${index + 1} ${labels[choice]}`).join(' · ');
}

export function permissionLines(record, width, bindings) {
  const values = [
    ['APPROVAL REQUIRED', `${record.tool}`], ['Action', record.action],
    ['Scope', record.scope], ['Effect', record.effect], ['Reversible', record.reversibility],
    ['Blast radius', record.blast_radius], ['Risk', `${record.risk}: ${record.reason_code}`],
    ['Reviewer', record.guidance], ['Arguments', safeJson(record.arguments ?? {})],
    ['Expires', formatExpiration(record.expires_at)],
  ];
  const lines = values.flatMap(([label, value]) => wrap(`${label}: ${value ?? 'not provided'}`, width));
  return isOneShot(record) ? [...lines, ...decisionLines(bindings)] : lines;
}

export function decoratePermissionLine(line) {
  return paint(TUI_THEME.muted, line);
}

function decisionLines(bindings) {
  return [
    '',
    `${keyLabel(bindings.allow_once)}  APPROVE ONCE`,
    `${keyLabel(bindings.cancel)}  CANCEL`,
    '',
  ];
}

function choicesFor(permission) {
  return Array.isArray(permission.choices)
    ? permission.choices : DEFAULT_PERMISSION_CHOICES;
}

function isOneShot(permission) {
  const choices = choicesFor(permission);
  return choices.length === 3 && choices.includes(ALLOW_ONCE) && choices.includes(DENY) && choices.includes(CANCEL);
}

function keyLabel(value) {
  if (!value) return 'unbound';
  return value.split('+').map((part) => {
    return part.length === 1 ? part.toUpperCase() : `${part[0].toUpperCase()}${part.slice(1)}`;
  }).join('+');
}

function formatExpiration(value) {
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.valueOf()) ? timestamp.toISOString() : 'not provided';
}

function safeJson(value) {
  try { return JSON.stringify(value) ?? '{}'; }
  catch { return '[unavailable]'; }
}

function wrap(value, width) {
  return wrapIndentedTerminalLine(String(value), width).slice(0, 64);
}
