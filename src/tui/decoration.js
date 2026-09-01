// SPDX-License-Identifier: Apache-2.0
import { decorateToolActivityLine } from './activity-renderer.js';
import { angledWordmarkGradient, decorateOverlay } from './colors.js';
import { decorateLiveActivity } from './live-activity.js';
import { decoratePermissionLine } from './permission-renderer.js';
import { displayWidth } from './terminal-markdown.js';
import { paint, TUI_THEME } from './theme.js';

const TRANSCRIPT_STATUS = /^\s*(?:STATE|REVIEW|DEPENDENCY|ATTACHMENT|\.\.\. WAITING FOR PROVIDER)\b/u;
const ACTIVITY_SUMMARY = /^\s+Activity summary/u;
const ACTIVITY_DETAIL = /^\s+v Activity detail/u;
const BULLET_LINE = /^\s+[*-](?:\s|$)/u;
const FOOTER_POSTURE = /^(?:prompt|auto-review|unattended)/iu;
const PASTED_IMAGES = /^\[pasted \d+ images?\]/u;
const FOOTER_STYLE_BY_KIND = Object.freeze({
  'work:goal:active': TUI_THEME.accent,
  'work:goal:blocked': TUI_THEME.warning,
  'work:goal:completed': TUI_THEME.mutedDark,
  'work:task:completed': TUI_THEME.mutedDark,
  'work:hint': TUI_THEME.mutedDark,
  'work:task:in_progress': TUI_THEME.activity,
  'work:compact': TUI_THEME.activity,
  'work:task:blocked': TUI_THEME.danger,
  'work:task:pending': TUI_THEME.primary,
});

export function decorateHeader(line, index, color) {
  if (!color) return line;
  if (index > 0) return paint(TUI_THEME.border, line);
  return line.replace(/\[[^\]]+\]/gu, (tab) => {
    if (/^\[(?:\*|@)/u.test(tab)) return paint(TUI_THEME.activeTab, tab);
    if (/^\[\+/u.test(tab)) return paint(TUI_THEME.accent, tab);
    return paint(TUI_THEME.mutedDark, tab);
  });
}

export function decorateContent(line, width, color, index, overlayKind, lineKind) {
  if (!color) return line;
  if (/^[╭╰]/u.test(line)) return paint(TUI_THEME.brandBorder, line);
  if (line.startsWith('│') && line.endsWith('│')) return decorateBanner(line, index);
  if (overlayKind === 'permission') return decoratePermissionLine(line);
  if (overlayKind) return decorateOverlay(line, width, overlayKind, lineKind);
  // Semantic record identity keeps wrapped rows in the same visual treatment
  // without adding renderer-only markers to copied transcript text.
  if (lineKind === 'user_input') return paint(TUI_THEME.inputTranscript, padCells(line, width));
  const toolActivity = decorateToolActivityLine(line, lineKind, paint);
  if (toolActivity) return toolActivity;
  if (lineKind === 'stream_delta' && line.startsWith('* ')) return `${paint(TUI_THEME.accent, '*')} ${line.slice(2)}`;
  if (TRANSCRIPT_STATUS.test(line)) {
    return paint(TUI_THEME.muted, line);
  }
  if (ACTIVITY_SUMMARY.test(line)) return paint(TUI_THEME.muted, line);
  if (ACTIVITY_DETAIL.test(line)) return paint(TUI_THEME.accentSoft, line);
  if (BULLET_LINE.test(line)) return paint(TUI_THEME.mutedDark, line);
  return line;
}

export function decorateFooter(line, index, length, color, animationFrame = 0, lineKind = '') {
  if (!color) return line;
  const activity = decorateLiveActivity(line, animationFrame);
  if (activity) return activity;
  if (lineKind === 'error') return paint(TUI_THEME.dangerStrong, line);
  if (lineKind === 'rule' || /^─+$/u.test(line)) return paint(TUI_THEME.border, line);
  if (lineKind === 'status' || index === length - 1) {
    const posture = line.match(FOOTER_POSTURE)?.[0];
    if (!posture) return paint(TUI_THEME.mutedDark, line);
    return `${paint(TUI_THEME.accent, posture)}${paint(TUI_THEME.mutedDark, line.slice(posture.length))}`;
  }
  if (lineKind === 'controls' || index === length - 2) return paint(TUI_THEME.mutedStrong, line);
  const footerStyle = FOOTER_STYLE_BY_KIND[lineKind];
  if (footerStyle) return paint(footerStyle, line);
  if (lineKind === 'editor') {
    if (!line.startsWith('> ')) return line;
    const body = line.slice(2).replace(PASTED_IMAGES, (marker) => paint(TUI_THEME.accentSoft, marker));
    return `${paint(TUI_THEME.inputMarker, '>')} ${body}`;
  }
  if (line.startsWith('/')) return paint(TUI_THEME.accentSoft, line);
  return line;
}

function decorateBanner(line, contentIndex) {
  if (typeof line !== 'string' || line.length < 2) return line;
  const middle = line.slice(1, -1);
  const wordmark = /[█╗╔║═╝]/u.test(middle);
  const styled = wordmark ? angledWordmarkGradient(middle, contentIndex - 1) : middle;
  return `${paint(TUI_THEME.brandBorder, '│')}${styled}${paint(TUI_THEME.brandBorder, '│')}`;
}

function padCells(value, width) {
  const currentWidth = displayWidth(value);
  if (!Number.isFinite(width) || !Number.isFinite(currentWidth)) return value;
  return `${value}${' '.repeat(Math.max(0, width - currentWidth))}`;
}
