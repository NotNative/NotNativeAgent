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
  if (overlayKind === 'question') return paint(TUI_THEME.primary, line);
  if (overlayKind) return decorateOverlay(line, width, overlayKind, lineKind);
  // Semantic record identity keeps wrapped rows in the same visual treatment
  // without adding renderer-only markers to copied transcript text.
  if (lineKind?.startsWith('user_input:')) return paint(TUI_THEME.inputTranscript, padCells(line, width));
  if (lineKind === 'context_compaction_status') return paint(TUI_THEME.contextStatus, line);
  if (lineKind?.startsWith('turn_receipt:')) return decorateReceiptLine(line, lineKind);
  const toolActivity = decorateToolActivityLine(line, lineKind, paint);
  if (toolActivity) return toolActivity;
  if (lineKind?.startsWith('stream_delta:')) return decorateAssistantLine(line, lineKind);
  if (TRANSCRIPT_STATUS.test(line)) {
    return paint(TUI_THEME.muted, line);
  }
  if (ACTIVITY_SUMMARY.test(line)) return paint(TUI_THEME.muted, line);
  if (ACTIVITY_DETAIL.test(line)) return paint(TUI_THEME.accentSoft, line);
  if (BULLET_LINE.test(line)) return paint(TUI_THEME.mutedDark, line);
  return line;
}

// Outcome carries the visual weight of a receipt; the body fields stay calm so
// a completed turn reads as settled history. Fields are our own grammar built
// by turnReceipt, so splitting them back is deterministic round-tripping, not
// prose inference.
const RECEIPT_STYLE = Object.freeze({
  completed: Object.freeze({ marker: TUI_THEME.success, body: TUI_THEME.mutedDark }),
  cancelled: Object.freeze({ marker: TUI_THEME.mutedDark, body: TUI_THEME.mutedDark, label: TUI_THEME.secondary }),
  needs_input: Object.freeze({ marker: TUI_THEME.warning, body: TUI_THEME.warning }),
  blocked: Object.freeze({ marker: TUI_THEME.warning, body: TUI_THEME.warning }),
  failed: Object.freeze({ marker: TUI_THEME.dangerStrong, body: TUI_THEME.mutedDark, label: TUI_THEME.dangerStrong }),
  incomplete: Object.freeze({ marker: TUI_THEME.danger, body: TUI_THEME.mutedDark, label: TUI_THEME.danger }),
  other: Object.freeze({ marker: TUI_THEME.danger, body: TUI_THEME.mutedDark, label: TUI_THEME.danger }),
});
const RECEIPT_FLAGGED_FIELD = /^\d+ flagged$/u;
const RECEIPT_CONTROL_FIELD = /^Ctrl\+O (?:details|collapse)$/u;

function decorateReceiptLine(line, lineKind) {
  const [, outcome, part] = lineKind.split(':');
  const style = RECEIPT_STYLE[outcome] ?? RECEIPT_STYLE.other;
  if (part !== 'first') return paint(style.body, line);
  const marker = line.match(/^ {2}(\S+)(?: (.*))?$/u);
  if (!marker) return paint(style.body, line);
  // The compact outcomes carry no label: their first field is data, not a caption.
  const labeled = !(outcome === 'completed' || outcome === 'blocked' || outcome === 'needs_input');
  const body = marker[2] === undefined ? '' : ` ${paintReceiptBody(marker[2], style, labeled)}`;
  return `  ${paint(style.marker, marker[1])}${body}`;
}

function paintReceiptBody(rest, style, labeled = false) {
  const separator = paint(style.body, ' | ');
  return rest.split(' | ').map((field, index) => {
    if (labeled && index === 0) return paint(style.label, field);
    if (RECEIPT_FLAGGED_FIELD.test(field)) return paint(TUI_THEME.warning, field);
    if (RECEIPT_CONTROL_FIELD.test(field) && style.body === TUI_THEME.mutedDark) return paint(TUI_THEME.mutedStrong, field);
    return paint(style.body, field);
  }).join(separator);
}

function decorateAssistantLine(line, lineKind) {  const semantic = lineKind.slice('stream_delta:'.length);
  const style = {
    heading: TUI_THEME.accentSoft, list: TUI_THEME.mutedDark,
    quote: TUI_THEME.muted, code: TUI_THEME.accentSoft,
  }[semantic];
  const marker = line.startsWith('* ') ? `${paint(TUI_THEME.accent, '*')} ` : '';
  const body = marker ? line.slice(2) : line;
  return `${marker}${style ? paint(style, body) : body}`;
}

export function decorateFooter(line, index, length, color, animationFrame = 0, lineKind = '') {
  if (!color) return line;
  const activity = decorateLiveActivity(line, animationFrame);
  if (activity) return activity;
  if (lineKind === 'error') return paint(TUI_THEME.dangerStrong, line);
  if (lineKind === 'rule' || /^─+$/u.test(line)) return paint(TUI_THEME.border, line);
  if (lineKind === 'status' || index === length - 1) {
    const posture = line.match(FOOTER_POSTURE)?.[0];
    if (!posture) return decorateStatusSegments(line);
    return `${paint(TUI_THEME.accent, posture)}${decorateStatusSegments(line.slice(posture.length))}`;
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

// Invariant: the status line is built by status-line.js from a fixed segment
// grammar, so re-splitting on the separator round-trips our own output; it can
// never interpret user or model prose.
const STATUS_CONTEXT_BAR = /^[▇▂]{5}$/u;
const STATUS_FALLBACK_BADGE = '(65k-fallback)';

function decorateStatusSegments(line) {
  return line.split(' | ').map(decorateStatusSegment).join(paint(TUI_THEME.mutedDark, ' | '));
}

function decorateStatusSegment(segment) {
  if (!segment.startsWith('context ')) return paint(TUI_THEME.mutedDark, segment);
  const parts = segment.split(' ').map((part) => {
    if (STATUS_CONTEXT_BAR.test(part)) return paintContextBar(part);
    if (part === STATUS_FALLBACK_BADGE) return paint(TUI_THEME.warning, part);
    return paint(TUI_THEME.mutedDark, part);
  });
  return parts.join(' ');
}

function paintContextBar(bar) {
  const filled = (bar.match(/▇/gu) ?? []).length;
  const color = filled >= 5 ? TUI_THEME.dangerStrong : filled >= 4 ? TUI_THEME.warning : TUI_THEME.success;
  return `${paint(color, bar.slice(0, filled))}${paint(TUI_THEME.mutedDark, bar.slice(filled))}`;
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
