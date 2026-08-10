// SPDX-License-Identifier: Apache-2.0
import { displayWidth } from './terminal-markdown.js';

export function decorateOverlay(line, width, kind) {
  if (/^─+$/u.test(line)) return paint('38;5;238', line);
  if (kind === 'provider' && line.includes('[ ')) return decorateRoleTabs(line);
  if (line === line.toUpperCase() && /[A-Z]/u.test(line)) return paint('1;38;5;141', line);
  if (line.startsWith('› ')) {
    const styled = decorateOverlayItem(line, kind, true);
    const padding = ' '.repeat(Math.max(0, width - displayWidth(line)));
    return `${paint('1;38;5;213;48;5;236', '›')} ${styled.slice(2)}${paint('48;5;236', padding)}`;
  }
  if (line.startsWith('    ')) return paint('38;5;245', line);
  if (line.startsWith('  ')) return decorateOverlayItem(line, kind, false);
  if (/^(?:Role|Profile|Model|Provider|Current|Default)\s{2,}/u.test(line)) {
    return line.replace(/^(Role|Profile|Model|Provider|Current|Default)(\s+)(.*)$/u, (_, label, gap, value) => (
      `${paint('38;5;245', label)}${gap}${paint(label === 'Current' ? '1;38;5;213' : '38;5;252', value)}`
    ));
  }
  if (/^(?:Choose|Available models)/u.test(line)) return paint('38;5;250', line);
  if (/^(?:Discovery unavailable|No model catalog)/u.test(line)) return paint('38;5;203', line);
  return paint('38;5;248', line);
}

function decorateRoleTabs(line) {
  const opening = line.indexOf('[');
  const closing = line.indexOf(']');
  if (opening < 0 || closing < opening) return paint('38;5;103', line);
  const prefix = line.slice(0, opening);
  const active = line.slice(opening, closing + 1);
  const remaining = line.slice(closing + 1);
  return `${paint('38;5;103', prefix)}${paint('1;38;5;255;48;5;54', active)}${paint('38;5;103', remaining)}`;
}

export function angledWordmarkGradient(value, row) {
  const stops = [
    [120, 240, 255], [200, 180, 255], [255, 120, 220],
    [240, 80, 200], [180, 60, 220], [110, 40, 180],
  ];
  const points = [...value];
  const first = points.findIndex((point) => point !== ' ');
  const last = points.findLastIndex((point) => point !== ' ');
  if (first < 0) return value;
  let result = points.slice(0, first).join('');
  for (let column = first; column <= last; column += 1) {
    const x = (column - first) / Math.max(1, last - first);
    const y = Math.max(0, Math.min(5, row)) / 5;
    const [red, green, blue] = gradientColor(stops, (x + y) / 2);
    result += paint(`38;2;${red};${green};${blue}`, points[column]);
  }
  return result + points.slice(last + 1).join('');
}

const SYNTHWAVE_ACTIVITY_STOPS = Object.freeze([
  Object.freeze([120, 240, 255]),
  Object.freeze([200, 180, 255]),
  Object.freeze([255, 120, 220]),
  Object.freeze([240, 80, 200]),
  Object.freeze([180, 60, 220]),
  Object.freeze([110, 40, 180]),
]);

export function synthwaveActivityIndicator(marker, label, frame = 0) {
  const index = Number.isInteger(frame) ? Math.abs(frame) % SYNTHWAVE_ACTIVITY_STOPS.length : 0;
  const [red, green, blue] = SYNTHWAVE_ACTIVITY_STOPS[index];
  return `  ${paint(`1;38;2;${red};${green};${blue}`, marker)} ${paint('38;5;147', label)}`;
}

function decorateOverlayItem(line, kind, selected) {
  if (kind !== 'model') return selected ? line : paint('38;5;252', line);
  const badgeStart = line.lastIndexOf('  [');
  const modelEnd = badgeStart >= 0 ? badgeStart : line.length;
  const prefix = line.slice(0, 2);
  const model = line.slice(2, modelEnd);
  const badge = badgeStart >= 0 ? line.slice(badgeStart) : '';
  const background = selected ? ';48;5;236' : '';
  const modelColor = selected ? `1;38;5;255${background}` : '38;5;252';
  return `${prefix}${paint(modelColor, model)}${badge ? paint(`38;5;103${background}`, badge) : ''}`;
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

function paint(codes, value) {
  return `\u001b[${codes}m${value}\u001b[0m`;
}
