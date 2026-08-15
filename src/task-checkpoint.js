// SPDX-License-Identifier: Apache-2.0
import { rename, unlink, writeFile } from 'node:fs/promises';
import { redactExtensionData, redactText } from './redaction.js';

const MAX_ITEM = 1_024;
const MAX_ITEMS = 12;

export function taskCheckpointPath(engine) {
  return engine?.store?.path ? `${engine.store.path}.task-state.md` : null;
}

export async function writeTaskCheckpoint(engine, fact) {
  const path = taskCheckpointPath(engine);
  if (!path) return null;
  const content = renderTaskCheckpoint(engine, fact);
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    try { await unlink(temporary); } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT' && Object.isExtensible(error)) {
        error.secondaryFailures = [...(error.secondaryFailures ?? []), cleanupError];
      }
    }
    throw error;
  }
  return path;
}

export function renderTaskCheckpoint(engine, fact) {
  const continuation = fact?.continuation ?? {};
  const work = engine?.work?.snapshot?.() ?? null;
  const lines = [
    '# NNA task checkpoint',
    '',
    '> Derived operational state. The durable session ledger remains authoritative for exact attributed evidence.',
    '> This file intentionally excludes verbatim conversation and raw tool payloads.',
    '',
    `- Session: ${safe(engine?.sessionId ?? 'unknown')}`,
    `- Updated: ${new Date().toISOString()}`,
    `- Source fingerprint: ${safe(fact?.sourceFingerprint ?? 'unknown')}`,
    `- Omitted ledger records: ${Number.isInteger(fact?.omitted) ? fact.omitted : 0}`,
    '',
    '## Objective',
    '',
    safe(work?.goal?.objective ?? continuation.objective ?? '(not recorded)'),
  ];
  addList(lines, 'Current tasks', work?.tasks?.map(taskLine) ?? []);
  addList(lines, 'Recent directives', continuation.recentDirectives);
  addList(lines, 'Completed work', continuation.completedWork);
  addList(lines, 'Changed files', continuation.changedFiles?.map(fileLine));
  addList(lines, 'Verified facts', continuation.verifiedFacts);
  addList(lines, 'Unresolved tools and blockers', continuation.unresolvedTools?.map(toolLine));
  addList(lines, 'Open questions', continuation.openQuestions);
  addList(lines, 'Next actions', continuation.nextActions);
  return `${lines.join('\n').trimEnd()}\n`;
}

function addList(lines, title, values = []) {
  const items = [...(values ?? [])].filter(Boolean).slice(-MAX_ITEMS);
  lines.push('', `## ${title}`, '');
  if (items.length === 0) lines.push('- None recorded');
  else lines.push(...items.map((item) => `- ${safe(item)}`));
}

function taskLine(task) {
  const detail = task.evidence ?? task.blockedReason;
  return `[${task.status}] ${task.id}: ${task.title}${detail ? ` - ${detail}` : ''}`;
}

function fileLine(item) {
  if (!item || typeof item !== 'object') return item;
  return `${item.path ?? '(unknown path)'} - ${item.operation ?? 'changed'} (${item.status ?? 'unknown'})`;
}

function toolLine(item) {
  if (!item || typeof item !== 'object') return item;
  return `${item.tool ?? item.name ?? 'tool'} - ${item.status ?? item.reason ?? 'unresolved'}`;
}

function safe(value) {
  const text = value && typeof value === 'object' ? serializeCheckpointValue(value) : String(value ?? '');
  return redactText(text).replaceAll(/\s+/gu, ' ').trim().slice(0, MAX_ITEM) || '(not recorded)';
}

function serializeCheckpointValue(value) {
  try {
    return JSON.stringify(redactExtensionData(value), (_key, child) => typeof child === 'bigint' ? String(child) : child);
  } catch { return '[unserializable]'; }
}
