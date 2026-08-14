// SPDX-License-Identifier: Apache-2.0
import { decorateToolActivityLine } from './tui-activity-renderer.js';
import { angledWordmarkGradient, decorateOverlay } from './tui-colors.js';
import { decorateLiveActivity } from './tui-live-activity.js';
import { decoratePermissionLine } from './tui-permission-renderer.js';
import { displayWidth } from './terminal-markdown.js';
import { paint, TUI_THEME } from './tui-theme.js';

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
  if (/^\s*(?:STATE|REVIEW|DEPENDENCY|ATTACHMENT|\.\.\. WAITING FOR PROVIDER)\b/u.test(line)) {
    return paint(TUI_THEME.muted, line);
  }
  if (/^\s+Activity summary/u.test(line)) return paint(TUI_THEME.muted, line);
  if (/^\s+v Activity detail/u.test(line)) return paint(TUI_THEME.accentSoft, line);
  if (/^\s+[*-](?:\s|$)/u.test(line)) return paint(TUI_THEME.mutedDark, line);
  return line;
}

export function decorateFooter(line, index, length, color, animationFrame = 0, lineKind = '') {
  if (!color) return line;
  const activity = decorateLiveActivity(line, animationFrame);
  if (activity) return activity;
  if (lineKind === 'rule' || /^─+$/u.test(line)) return paint(TUI_THEME.border, line);
  if (lineKind === 'status' || index === length - 1) {
    const status = paint(TUI_THEME.mutedDark, line);
    return status.replace(/^(?:prompt|auto-review|unattended)/u, (posture) => paint(TUI_THEME.accent, posture));
  }
  if (lineKind === 'controls' || index === length - 2) return paint(TUI_THEME.mutedStrong, line);
  if (lineKind === 'editor') {
    if (!line.startsWith('> ')) return line;
    const body = line.slice(2).replace(/^\[pasted \d+ images?\]/u, (marker) => paint(TUI_THEME.accentSoft, marker));
    return `${paint(TUI_THEME.inputMarker, '>')} ${body}`;
  }
  if (line.startsWith('/')) return paint(TUI_THEME.accentSoft, line);
  return line;
}

function decorateBanner(line, contentIndex) {
  const middle = line.slice(1, -1);
  const wordmark = /[█╗╔║═╝]/u.test(middle);
  const styled = wordmark ? angledWordmarkGradient(middle, contentIndex - 1) : middle;
  return `${paint(TUI_THEME.brandBorder, '│')}${styled}${paint(TUI_THEME.brandBorder, '│')}`;
}

function padCells(value, width) {
  return `${value}${' '.repeat(Math.max(0, width - displayWidth(value)))}`;
}
