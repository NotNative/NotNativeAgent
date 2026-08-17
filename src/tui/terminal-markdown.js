// SPDX-License-Identifier: Apache-2.0
import { sanitizeTerminal } from './terminal-adapter.js';

export function renderMarkdown(value, width, firstPrefix = '', continuationPrefix = '') {
  const source = asciiPresentation(sanitizeTerminal(value)).replaceAll('\r\n', '\n').replaceAll('\r', '\n').replace(/^\n+|\n+$/gu, '');
  const lines = [];
  let fenced = false;
  for (const raw of source.split('\n')) {
    const fence = /^\s*```\s*([^`]*)$/u.exec(raw);
    if (fence) {
      fenced = !fenced;
      if (fenced && fence[1].trim()) {
        const prefix = lines.length === 0 ? firstPrefix : continuationPrefix;
        lines.push(...wrapTerminalLine(`[${fence[1].trim()}]`, width, prefix));
      }
      continue;
    }
    const normalized = fenced ? `  ${raw.replaceAll('\t', '  ')}` : markdownLine(raw);
    const prefix = lines.length === 0 ? firstPrefix : continuationPrefix;
    lines.push(...wrapTerminalLine(normalized, width, prefix, hangingPrefix(continuationPrefix, normalized)));
  }
  return lines.length > 0 ? lines : [firstPrefix];
}

function asciiPresentation(value) {
  return value
    .replace(/[•●○◦▪]/gu, '-')
    .replace(/[✓✔]/gu, 'OK')
    .replace(/[✗✘×]/gu, 'X')
    .replace(/[→⇒]/gu, '->')
    .replace(/[←⇐]/gu, '<-');
}

export function wrapTerminalLine(value, width, prefix = '', continuationPrefix = null) {
  const safeWidth = Math.max(1, width);
  const clean = sanitizeTerminal(value).replaceAll('\t', '  ');
  if (clean.length === 0) return [prefix.slice(0, safeWidth)];
  const result = [];
  let remaining = clean;
  let currentPrefix = prefix;
  const nextPrefix = continuationPrefix ?? ' '.repeat(displayWidth(prefix));
  while (remaining.length > 0) {
    const room = Math.max(1, safeWidth - displayWidth(currentPrefix));
    const split = splitAtWidth(remaining, room);
    result.push(`${currentPrefix}${split.head}`);
    remaining = split.tail.replace(/^\s+/u, '');
    currentPrefix = nextPrefix;
  }
  return result;
}

export function wrapIndentedTerminalLine(value, width) {
  const clean = sanitizeTerminal(value).replaceAll('\t', '  ');
  const indentation = /^\s*/u.exec(clean)?.[0] ?? '';
  const content = clean.slice(indentation.length);
  // Activity rows use a status glyph, tool name, and optional target. Hang
  // wrapped target/task text beneath the start of that target instead of only
  // beneath the status marker. This keeps long shell and agent.run rows
  // visually distinct from assistant transcript text.
  const activityLead = /^(?:\u2713|\u25cf|X|\+)\s+[\w.:-]+(?:\s+\()?/u.exec(content)?.[0]
    ?? /^(?:\u2713|\u25cf|X|\+)\s+/u.exec(content)?.[0]
    ?? '';
  const continuation = `${indentation}${' '.repeat(displayWidth(activityLead))}`;
  return wrapTerminalLine(content, width, indentation, continuation);
}

export function displayWidth(value) {
  let width = 0;
  for (const point of String(value)) {
    if (/\p{Mark}/u.test(point) || point === '\u200d' || /[\ufe00-\ufe0f]/u.test(point)) continue;
    width += isWide(point.codePointAt(0)) ? 2 : 1;
  }
  return width;
}

export function truncateTerminal(value, maximum) {
  let result = '';
  let width = 0;
  for (const point of String(value)) {
    const next = width + displayWidth(point);
    if (next > maximum) break;
    result += point;
    width = next;
  }
  return result;
}

function markdownLine(raw) {
  let line = raw.replace(/^\s{0,3}#{1,6}\s+/u, '');
  line = line.replace(/^\s*>\s?/u, '| ');
  line = line.replace(/^(\s*)[-*+]\s+/u, '$1- ');
  line = line.replace(/^(\s*)\[(?: |x|X)\]\s+/u, '$1[ ] ');
  line = line.replace(/!\[([^\]]*)\]\(((?:[^()]|\([^()]*\))+)\)/gu, '[image: $1] <$2>');
  line = line.replace(/\[([^\]]+)\]\(((?:[^()]|\([^()]*\))+)\)/gu, '$1 <$2>');
  line = line.replace(/\*\*([^*]*)\*\*|__([^_]*)__/gu, '$1$2');
  line = line.replace(/~~([^~]*)~~/gu, '$1');
  line = line.replace(/`([^`]+)`/gu, '$1');
  return line.replace(/\\([\\`*_[\]{}()#+.!>-])/gu, '$1');
}

function hangingPrefix(prefix, value) {
  const structural = /^(\s*)(?:(?:[-*+]\s+)|(?:\d+[.)]\s+))/u.exec(value);
  if (structural) return `${prefix}${' '.repeat(displayWidth(structural[0]))}`;
  const indentation = /^\s+/u.exec(value)?.[0] ?? '';
  return `${prefix}${' '.repeat(displayWidth(indentation))}`;
}

function splitAtWidth(value, maximum) {
  if (!value) return { head: '', tail: '' };
  let width = 0;
  let index = 0;
  let breakAt = -1;
  for (const point of value) {
    const next = width + displayWidth(point);
    if (next > maximum) break;
    index += point.length;
    width = next;
    if (/\s/u.test(point)) breakAt = index;
  }
  if (index >= value.length) return { head: value, tail: '' };
  const split = breakAt > 0 ? breakAt : index > 0 ? index : [...value][0].length;
  return { head: value.slice(0, split).trimEnd(), tail: value.slice(split) };
}

function isWide(code) {
  return code >= 0x1100 && (code <= 0x115f || code === 0x2329 || code === 0x232a
    || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f)
    || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe10 && code <= 0xfe19) || (code >= 0xfe30 && code <= 0xfe6f)
    || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6)
    || (code >= 0x1f300 && code <= 0x1faff) || (code >= 0x20000 && code <= 0x3fffd));
}
