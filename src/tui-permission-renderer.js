// SPDX-License-Identifier: Apache-2.0
import { wrapIndentedTerminalLine } from './terminal-markdown.js';

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
  if (record.tool === 'system.elevate') return elevationLines(record, width, bindings);
  const values = [
    ['APPROVAL REQUIRED', `${record.tool}`], ['Action', record.action],
    ['Scope', record.scope], ['Effect', record.effect], ['Reversible', record.reversibility],
    ['Blast radius', record.blast_radius], ['Risk', `${record.risk}: ${record.reason_code}`],
    ['Reviewer', record.guidance], ['Arguments', JSON.stringify(record.arguments)],
    ['Expires', new Date(record.expires_at).toISOString()],
  ];
  const lines = values.flatMap(([label, value]) => wrap(`${label}: ${value ?? 'not provided'}`, width));
  return isOneShot(record) ? [...lines, ...decisionLines(bindings)] : lines;
}

export function decoratePermissionLine(line) {
  if (line === 'ELEVATED COMMAND APPROVAL') return paint('1;38;5;213', line);
  if (line.startsWith('Ctrl+Y')) return paint('1;38;5;77', line);
  if (line.startsWith('Ctrl+C')) return paint('1;38;5;203', line);
  if (/^(?:Reason|Expected effect|Command|Working directory|Reviewer):/u.test(line)) {
    return line.replace(/^([^:]+:)(.*)$/u, (_, label, value) => `${paint('1;38;5;147', label)}${value}`);
  }
  if (/^(?:This approval|NNA is requesting)/u.test(line)) return paint('38;5;250', line);
  return paint('38;5;245', line);
}

function elevationLines(record, width, bindings) {
  const args = record.arguments ?? {};
  const values = [
    'ELEVATED COMMAND APPROVAL',
    'NNA is requesting administrator privileges for one exact command.',
    '',
    `Reason: ${args.reason ?? record.guidance ?? 'not provided'}`,
    `Expected effect: ${args.expected_effect ?? 'not provided'}`,
    `Command: ${commandText(args)}`,
    `Working directory: ${args.cwd ?? 'current working directory'}`,
    `Reviewer: ${record.guidance ?? 'approved for local operator confirmation'}`,
    '',
    'This approval applies once, to this exact command, and cannot be remembered.',
    ...decisionLines(bindings),
  ];
  return values.flatMap((line) => line === '' ? [''] : wrap(line, width));
}

function decisionLines(bindings) {
  return [
    '',
    `${keyLabel(bindings.allow_once)}  APPROVE ONCE`,
    `${keyLabel(bindings.cancel)}  CANCEL`,
    '',
  ];
}

function commandText(args) {
  const executable = args.executable ?? 'unknown executable';
  const argv = Array.isArray(args.args) ? args.args.map(displayArgument) : [];
  return [executable, ...argv].join(' ');
}

function displayArgument(value) {
  const text = String(value);
  return /[\s"']/u.test(text) ? JSON.stringify(text) : text;
}

function choicesFor(permission) {
  return Array.isArray(permission.choices)
    ? permission.choices : ['allow_once', 'allow_session', 'allow_workspace', 'deny', 'cancel'];
}

function isOneShot(permission) {
  const choices = choicesFor(permission);
  return choices.length === 3 && choices.includes('allow_once') && choices.includes('cancel');
}

function keyLabel(value) {
  if (!value) return 'unbound';
  return value.split('+').map((part) => (
    part.length === 1 ? part.toUpperCase() : `${part[0].toUpperCase()}${part.slice(1)}`
  )).join('+');
}

function wrap(value, width) {
  return wrapIndentedTerminalLine(String(value), width).slice(0, 64);
}

function paint(codes, value) {
  return `\u001b[${codes}m${value}\u001b[0m`;
}
