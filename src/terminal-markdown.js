// SPDX-License-Identifier: Apache-2.0
import { sanitizeTerminal } from './terminal-adapter.js';

export function renderMarkdown(value, width, firstPrefix = '', continuationPrefix = '') {
  const source = asciiPresentation(sanitizeTerminal(value)).replaceAll('\r\n', '\n').replaceAll('\r', '\n');
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
    lines.push(...wrapTerminalLine(normalized, width, lines.length === 0 ? firstPrefix : continuationPrefix));
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

export function wrapTerminalLine(value, width, prefix = '') {
  const safeWidth = Math.max(1, width);
  const clean = sanitizeTerminal(value).replaceAll('\t', '  ');
  if (clean.length === 0) return [prefix.slice(0, safeWidth)];
  const result = [];
  let remaining = clean;
  let currentPrefix = prefix;
  while (remaining.length > 0) {
    const room = Math.max(1, safeWidth - displayWidth(currentPrefix));
    const split = splitAtWidth(remaining, room);
    result.push(`${currentPrefix}${split.head}`);
    remaining = split.tail.replace(/^\s+/u, '');
    currentPrefix = ' '.repeat(displayWidth(prefix));
  }
  return result;
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
  line = line.replace(/!\[([^\]]*)\]\(([^)]+)\)/gu, '[image: $1] <$2>');
  line = line.replace(/\[([^\]]+)\]\(([^)]+)\)/gu, '$1 <$2>');
  line = line.replace(/\*\*([^*]+)\*\*|__([^_]+)__/gu, '$1$2');
  line = line.replace(/~~([^~]+)~~/gu, '$1');
  line = line.replace(/`([^`]+)`/gu, '$1');
  return line.replace(/\\([\\`*_[\]{}()#+.!>-])/gu, '$1');
}

function splitAtWidth(value, maximum) {
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
