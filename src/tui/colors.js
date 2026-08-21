// SPDX-License-Identifier: Apache-2.0
import { displayWidth } from './terminal-markdown.js';
import { paint, TUI_THEME } from './theme.js';

const ITEM_INDENT = '  ';
const DETAIL_INDENT = '    ';
const SELECTED_MARKER = '›';
const MODEL_BADGE_DELIMITER = '  [';
const LABEL_LINE = /^(?:Role|Profile|Model|Provider|Current|Default)\s{2,}/u;
const LABEL_PARTS = /^(Role|Profile|Model|Provider|Current|Default)(\s+)(.*)$/u;
const CHOICE_HEADING = /^(?:Choose|Available models)/u;
const UNAVAILABLE_MESSAGE = /^(?:Discovery unavailable|No model catalog)/u;
const SYNTHWAVE_STOPS = Object.freeze([
  Object.freeze([120, 240, 255]),
  Object.freeze([200, 180, 255]),
  Object.freeze([255, 120, 220]),
  Object.freeze([240, 80, 200]),
  Object.freeze([180, 60, 220]),
  Object.freeze([110, 40, 180]),
]);

export function decorateOverlay(line, width, kind, lineKind = '') {
  if (lineKind.endsWith(':selected')) return decorateSelectedOverlayLine(line, width);
  if (kind === 'support-error' || lineKind === 'overlay:error') return paint(TUI_THEME.dangerStrong, line);
  if (lineKind === 'overlay:warning') return paint(TUI_THEME.warning, line);
  if (/^─+$/u.test(line)) return paint(TUI_THEME.border, line);
  if (kind === 'provider' && line.includes('[ ')) return decorateRoleTabs(line);
  if (line === line.toUpperCase() && /[A-Z]/u.test(line)) return paint(TUI_THEME.accentSoft, line);
  if (line.startsWith(DETAIL_INDENT)) return paint(TUI_THEME.muted, line);
  if (line.startsWith(ITEM_INDENT)) return decorateOverlayItem(line, kind);
  if (LABEL_LINE.test(line)) {
    return line.replace(LABEL_PARTS, (_, label, gap, value) => (
      `${paint(TUI_THEME.muted, label)}${gap}${paint(label === 'Current' ? TUI_THEME.accent : TUI_THEME.primary, value)}`
    ));
  }
  if (CHOICE_HEADING.test(line)) return paint(TUI_THEME.secondaryStrong, line);
  if (UNAVAILABLE_MESSAGE.test(line)) return paint(TUI_THEME.danger, line);
  return paint(TUI_THEME.secondary, line);
}

function decorateSelectedOverlayLine(line, width) {
  const marker = line.startsWith(`${SELECTED_MARKER} `);
  const body = marker ? line.slice(2) : line;
  const prefixWidth = marker ? 2 : 0;
  const padded = `${marker ? ' ' : ''}${body}${' '.repeat(Math.max(0, width - prefixWidth - displayWidth(body)))}`;
  return marker
    ? `${paint(TUI_THEME.selectedMarker, SELECTED_MARKER)}${paint(TUI_THEME.selected, padded)}`
    : paint(TUI_THEME.selected, padded);
}

function decorateRoleTabs(line) {
  const opening = line.indexOf('[');
  const closing = line.indexOf(']');
  if (opening < 0 || closing < opening) return paint(TUI_THEME.mutedDark, line);
  const prefix = line.slice(0, opening);
  const active = line.slice(opening, closing + 1);
  const remaining = line.slice(closing + 1);
  return `${paint(TUI_THEME.mutedDark, prefix)}${paint(TUI_THEME.activeTab, active)}${paint(TUI_THEME.mutedDark, remaining)}`;
}

export function angledWordmarkGradient(value, row) {
  const points = [...value];
  const first = points.findIndex((point) => point !== ' ');
  const last = points.findLastIndex((point) => point !== ' ');
  if (first < 0) return value;
  let result = points.slice(0, first).join('');
  for (let column = first; column <= last; column += 1) {
    const x = (column - first) / Math.max(1, last - first);
    const y = Math.max(0, Math.min(5, row)) / 5;
    const [red, green, blue] = gradientColor(SYNTHWAVE_STOPS, (x + y) / 2);
    result += paint(`38;2;${red};${green};${blue}`, points[column]);
  }
  return result + points.slice(last + 1).join('');
}

export function synthwaveActivityIndicator(marker, label, frame = 0) {
  const index = Number.isInteger(frame) ? Math.abs(frame) % SYNTHWAVE_STOPS.length : 0;
  const [red, green, blue] = SYNTHWAVE_STOPS[index];
  return `${ITEM_INDENT}${paint(`1;38;2;${red};${green};${blue}`, marker)} ${paint(TUI_THEME.activity, label)}`;
}

function decorateOverlayItem(line, kind) {
  if (kind !== 'model') return paint(TUI_THEME.primary, line);
  const badgeStart = line.lastIndexOf(MODEL_BADGE_DELIMITER);
  const modelEnd = badgeStart >= 0 ? badgeStart : line.length;
  const prefix = line.slice(0, ITEM_INDENT.length);
  const model = line.slice(ITEM_INDENT.length, modelEnd);
  const badge = badgeStart >= 0 ? line.slice(badgeStart) : '';
  return `${prefix}${paint(TUI_THEME.primary, model)}${badge ? paint(TUI_THEME.mutedDark, badge) : ''}`;
}

function gradientColor(stops, position) {
  const scaled = Math.max(0, Math.min(1, position)) * (stops.length - 1);
  const index = Math.floor(scaled);
  if (index >= stops.length - 1) return stops.at(-1);
  const amount = scaled - index;
  return stops[index].map((value, channel) => Math.round(
    value + ((stops[index + 1][channel] - value) * amount),
  ));
}
