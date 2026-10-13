// SPDX-License-Identifier: Apache-2.0
/**
 * Session transcript export (W-24.export): compose the loaded turns into a
 * portable Markdown document and hand it to the browser as a download. The
 * export covers exactly what the timeline shows — user and assistant text
 * turns in chronological order; synthetic/ignored parts are excluded, and
 * tool activity is summarized as an aside rather than dumped.
 */
import type { StoreApi } from 'zustand/vanilla';
import type { DirectoryStore } from '../sync/types.ts';
import { projectTurns, type PartLite } from './turns.ts';
import { formatRelative } from './time-format.ts';

export function sessionMarkdown(store: StoreApi<DirectoryStore>, sessionID: string, title?: string): string {
  const snapshot = store.getState();
  const turns = projectTurns(snapshot.message[sessionID] ?? []);
  const lines: string[] = [`# ${title || sessionID}`, '',
    `Exported from NotNativeDesktop · ${turns.length} turn${turns.length === 1 ? '' : 's'} · ${new Date().toISOString()}`, ''];
  for (const turn of turns) {
    const at = new Date(turn.userMessage.time.created).toISOString();
    const prompt = textOf((snapshot.part[turn.userMessage.id] ?? []) as PartLite[]);
    lines.push(`## ${at} — Prompt`, '', prompt || '[No text content]', '');
    for (const reply of turn.assistant ?? []) {
      const replyAt = new Date(reply.time.created).toISOString();
      const parts = (snapshot.part[reply.id] ?? []) as PartLite[];
      const body = textOf(parts);
      const tools = parts.filter((part) => part.type === 'tool');
      const aside = tools.length > 0 ? `\n\n> ${tools.length} tool call${tools.length === 1 ? '' : 's'} omitted` : '';
      lines.push(`## ${replyAt} — Reply`, '', (body || '[No text content]') + aside, '');
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function textOf(parts: PartLite[]): string {
  return (parts as PartLite[]).filter((part) => part.type === 'text' && !part.synthetic && !part.ignored)
    .map((part) => part.text ?? '').join('\n').trim();
}

export function downloadSessionMarkdown(fileName: string, content: string): void {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function exportSession(store: StoreApi<DirectoryStore>, sessionID: string, title?: string): void {
  downloadSessionMarkdown(`${(title || sessionID).replace(/[^\w.-]+/gu, '_').slice(0, 80) || 'session'}.md`,
    sessionMarkdown(store, sessionID, title));
}
