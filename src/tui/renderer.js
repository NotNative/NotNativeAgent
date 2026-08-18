// SPDX-License-Identifier: Apache-2.0
import { sanitizeTerminal } from './terminal-adapter.js';
import { commandPresentation, commandsByCategory } from './commands.js';
import { commandPickerLines } from './command-picker.js';
import { PRODUCT_NAME, VERSION } from '../product.js';
import { activityDetailRows, collapsedFailureRows, subagentProgressLines, summaryActivityRows, toolFailureSuffix, toolSymbol, toolTargetSuffix } from './activity-renderer.js';
import { liveActivityLine } from './live-activity.js';
import { displayWidth, renderMarkdown, truncateTerminal, wrapIndentedTerminalLine, wrapTerminalLine } from './terminal-markdown.js';
import { sessionStatusLine } from './status-line.js';
import { decorateSelection, plainTerminalLine } from './selection.js';
import { contextCompactionText } from './context-renderer.js';
import { applyConversationSpacing } from './conversation-spacing.js';
import { permissionControlLine, permissionLines } from './permission-renderer.js';
import { decorateContent, decorateFooter, decorateHeader } from './decoration.js';
import { workSummaryRows } from './work-summary.js';
import { detailedTokenText, receiptTokenText } from '../experience/token-accounting.js';
import { latestToolStatusIndexes, toolStatusIdentity } from '../experience/tool-lifecycle.js';
export class TuiRenderer {
  frame(projection, capabilities) {
    const session = projection.active();
    if (!session) return `${PRODUCT_NAME} ${VERSION}\n[IDLE] No conversation\n`;
    // Leave two cells unused because some Windows hosts render status glyphs wider than reported.
    const width = Math.max(23, capabilities.width - 2);
    const height = Math.max(8, capabilities.height);
    const header = headerLines(projection, session, width);
    const suggestionCapacity = Math.max(3, height - header.length - 8);
    const footerKinds = [];
    const footer = footerLines(projection, session, width, capabilities, suggestionCapacity, footerKinds);
    const room = Math.max(1, height - header.length - footer.length);
    const targets = new Map();
    const lineKinds = new Map();
    const available = contentLines(projection, session, width, targets, lineKinds, height);
    restoreHistoryAnchor(session, available.length);
    if (!session.pendingPermission && !projection.help && !projection.overlay) session.viewportLineCount = available.length;
    const permissionStart = Math.min(session.permissionOffset, Math.max(0, available.length - room));
    const viewportEnd = session.viewportEnd === null
      ? available.length : Math.min(session.viewportEnd, available.length);
    if (session.viewportEnd !== null && viewportEnd >= available.length) session.viewportEnd = null;
    const overlayStart = projection.overlay
      ? visibleOverlayStart(projection.overlay, targets, room, available.length)
      : 0;
    const contentStart = visibleContentStart({
      pendingPermission: session.pendingPermission, permissionStart, overlay: projection.overlay,
      overlayStart, help: projection.help, viewportEnd, room,
    });
    const content = available.slice(contentStart, contentStart + room);
    projection.selectionDocumentLines = available.map(plainTerminalLine);
    projection.selectionRowMap = new Map(content.map((_line, index) => [header.length + index + 1, contentStart + index]));
    projection.selectionContentBounds = { first: header.length + 1, last: header.length + content.length };
    const visibleTargets = [...targets.entries()]
      .filter(([index]) => index >= contentStart && index < contentStart + content.length)
      .map(([index, target]) => Object.freeze({ ...target, row: header.length + index - contentStart + 1 }));
    const workRow = footerKinds.findIndex((kind) => kind === 'work:compact' || kind?.startsWith('work:goal:'));
    const workTargetRow = header.length + content.length + workRow + 1;
    if (workRow >= 0 && workTargetRow <= height) {
      visibleTargets.push(Object.freeze({ type: 'work-summary', row: workTargetRow }));
    }
    projection.mouseTargets = Object.freeze(visibleTargets);
    const color = capabilities.color === true;
    const frame = [
      ...header.map((line, index) => decorateHeader(line, index, color)),
      ...content.map((line, index) => decorateContent(
        line, width, color, index, session.pendingPermission ? 'permission' : projection.overlay?.kind,
        lineKinds.get(contentStart + index),
      )),
      ...footer.map((line, index) => decorateFooter(
        line, index, footer.length, color, capabilities.animationFrame, footerKinds[index],
      )),
    ];
    const visible = frame.slice(0, height);
    projection.visibleFrame = Object.freeze(visible.map(plainTerminalLine));
    return `${decorateSelection(visible, projection.terminalSelection).join('\n')}\n`;
  }
}
export function headerTargetAt(projection, column) {
  let start = 1;
  const sessions = [...projection.sessions.values()];
  for (const [index, session] of sessions.entries()) {
    const width = displayWidth(tabLabel(session, projection.activeId));
    if (column >= start && column < start + width) return { type: 'session', id: session.id };
    start += width + (index < sessions.length - 1 ? 1 : 0);
  }
  const addStart = start + 2;
  return column >= addStart && column < addStart + 3 ? { type: 'new_tab' } : null;
}

function headerLines(projection, session, width) {
  const tabs = [...projection.sessions.values()].map((item) => tabLabel(item, projection.activeId)).join(' ');
  return [
    crop(`${tabs}  [+]`, width),
    rule(width),
  ];
}

function contentLines(projection, session, width, targets = new Map(), lineKinds = new Map(), height = 24) {
  if (session.pendingPermission) return permissionLines(session.pendingPermission, width, projection.bindings);
  if (projection.overlay) return overlayLines(projection.overlay, width, targets, lineKinds);
  if (projection.help) return helpLines(width, projection.bindings, session);
  const lines = [...sessionBanner(session, width, height), ''];
  const records = [...session.historyRecords, ...session.records];
  const completed = new Set(records.filter((record) => record.type === 'turn_result').map((record) => record.turn_id));
  const activity = activityByTurn(records, completed);
  const latestToolStatuses = latestToolStatusIndexes(records);
  let lastVisibleKind = null;
  let lastMessageKind = null;
  for (let recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
    const record = records[recordIndex];
    if (isActivity(record) && completed.has(record.turn_id)) continue;
    const toolIdentity = toolStatusIdentity(record);
    if (record.type === 'tool_status' && toolIdentity
      && latestToolStatuses.get(toolIdentity) !== recordIndex) continue;
    if (record.type === 'turn_result') {
      const activityRecords = activity.get(record.turn_id) ?? [];
      const summary = summarizeActivity(activityRecords);
      const mode = session.detailedTurns.has(record.turn_id) ? 'details'
        : session.expandedTurns.has(record.turn_id) ? 'summary' : 'collapsed';
      if (mode === 'details') lines.push(...activityDetailRows(activityRecords, width, wrapIndentedTerminalLine));
      else if (mode === 'summary') lines.push(...summaryActivityRows(activityRecords).flatMap((line) => wrapIndentedTerminalLine(line, width)));
      else lines.push(...collapsedFailureRows(activityRecords).flatMap((line) => wrapIndentedTerminalLine(line, width)));
      const receiptStart = lines.length;
      const receipt = turnReceipt(record, summary, mode, width);
      lines.push(...receipt, '');
      if (mode !== 'details') {
        for (let index = receiptStart; index < receiptStart + receipt.length; index += 1) {
          targets.set(index, { type: 'activity', turnId: record.turn_id });
        }
      }
      lastVisibleKind = 'turn_result';
      continue;
    }
    const rendered = recordLines(record, width); if (rendered.length === 0) continue;
    applyConversationSpacing(lines, record.type, lastMessageKind, lastVisibleKind);
    const start = lines.length;
    lines.push(...rendered);
    const lineKind = record.type === 'tool_status'
      ? `${record.type}:${record.status ?? 'unknown'}`
      : record.type;
    for (let index = start; index < lines.length; index += 1) lineKinds.set(index, lineKind);
    lastVisibleKind = isActivity(record) ? 'activity' : record.type;
    if (['user_input', 'stream_delta'].includes(record.type)) lastMessageKind = record.type;
  }
  return lines;
}

function restoreHistoryAnchor(session, nextLineCount) {
  if (!session.historyAnchor) return;
  const added = Math.max(0, nextLineCount - session.historyAnchor.lineCount);
  session.viewportEnd = Math.min(nextLineCount, session.historyAnchor.end + added);
  session.historyAnchor = null;
}

function sessionBanner(session, width, height) {
  const compact = height < 24;
  const values = compact ? [
    `${PRODUCT_NAME} · v${VERSION}`,
    `${session.metadata.model} · ${session.metadata.workspace ?? '--'}`,
  ] : [
    ...wordmark(width, height),
    `${PRODUCT_NAME} · v${VERSION}`,
    '',
    `Provider   ${session.metadata.endpoint ?? session.metadata.provider}${session.metadata.temporaryRoute ? ' (temporary)' : ''}`,
    `Model      ${session.metadata.model}`,
    `Workspace  ${session.metadata.workspace ?? '--'}`,
    '',
    'Ready · type /help to browse commands',
  ];
  return [boxTop('NNA CONSOLE', width), ...values.map((line) => boxLine(line, width)), boxBottom(width)];
}

function wordmark(width, height) {
  if (width < 52 || height < 24) return [];
  return [
    '  ███╗   ██╗ ███╗   ██╗  █████╗ ',
    '  ████╗  ██║ ████╗  ██║ ██╔══██╗',
    '  ██╔██╗ ██║ ██╔██╗ ██║ ███████║',
    '  ██║╚██╗██║ ██║╚██╗██║ ██╔══██║',
    '  ██║ ╚████║ ██║ ╚████║ ██║  ██║',
    '  ╚═╝  ╚═══╝ ╚═╝  ╚═══╝ ╚═╝  ╚═╝',
  ];
}

function boxTop(label, width) {
  const inner = Math.max(1, width - 2);
  const title = truncateTerminal(` ${label} `, inner);
  return `╭${title}${'─'.repeat(Math.max(0, inner - displayWidth(title)))}╮`;
}

function boxLine(value, width) {
  const inner = Math.max(1, width - 2);
  const text = truncateTerminal(` ${value}`, inner);
  return `│${padCells(text, inner)}│`;
}

function boxBottom(width) {
  return `╰${'─'.repeat(Math.max(1, width - 2))}╯`;
}

function footerLines(projection, session, width, capabilities = {}, suggestionCapacity = 3, lineKinds = []) {
  const lines = [rule(width)];
  lineKinds.push('rule');
  const add = (values, kind) => {
    const rows = Array.isArray(values) ? values : [values];
    lines.push(...rows); lineKinds.push(...rows.map(() => kind));
  };
  if (session.pendingPermission) {
    add(crop(permissionControlLine(session.pendingPermission, projection.bindings), width), 'controls');
    add(footerStatusLine(projection, session, width), 'status');
    return lines;
  }
  if (projection.overlay) {
    const action = projection.overlay.actionLabel
      ?? (projection.overlay.items?.length ? '↑↓ choose · Enter select' : '↑↓ scroll');
    add(crop(`${action} · Esc back · Ctrl+G/Ctrl+C close · ${projection.overlay.kind}`, width), 'controls');
    add(footerStatusLine(projection, session, width), 'status');
    return lines;
  }
  if (projection.notice && projection.notice.kind !== 'confirmation') add(crop(`[${projection.notice.kind.toUpperCase()}] ${projection.notice.text}`, width), 'notice');
  add(commandPickerLines(session, projection, suggestionCapacity).map((line) => crop(line, width)), 'suggestion');
  const activity = liveActivityLine(session, capabilities);
  if (activity) add(crop(activity, width), 'activity');
  for (const row of workSummaryRows(session.work, width, capabilities.height ?? 24, session.workCollapsed)) {
    add(crop(row.text, width), row.kind);
  }
  add(editorLines(session, width), 'editor');
  add(rule(width), 'rule');
  add(crop(controlLine(session, projection.bindings), width), 'controls');
  add(footerStatusLine(projection, session, width), 'status');
  return lines;
}

function footerStatusLine(projection, session, width) {
  if (projection.notice?.kind === 'confirmation') return crop(projection.notice.text, width);
  return sessionStatusLine(session, width, projection.updateAvailable ? 'update available' : '');
}

function overlayLines(overlay, width, targets = new Map(), lineKinds = new Map()) {
  const lines = [crop(overlay.title.toUpperCase(), width), rule(width)];
  lineKinds.set(0, 'overlay:title'); lineKinds.set(1, 'overlay:rule');
  if (overlay.tabs?.length) {
    const tabs = overlay.tabs.map((tab) => tab.active ? `[ ${tab.label.toUpperCase()} ]` : tab.label.toUpperCase()).join('   ');
    lines.push(crop(tabs, width), '');
    lineKinds.set(lines.length - 2, 'overlay:tabs');
  }
  for (const [lineIndex, line] of overlay.lines.entries()) {
    const start = lines.length;
    lines.push(...wrap(line, width));
    const kind = overlay.lineKinds?.[lineIndex] || 'body';
    for (let row = start; row < lines.length; row += 1) lineKinds.set(row, `overlay:${kind}`);
  }
  let section = null;
  for (const [index, item] of (overlay.items ?? []).entries()) {
    if (item.section && item.section !== section) {
      lines.push('', crop(item.section.toUpperCase(), width));
      lineKinds.set(lines.length - 1, 'overlay:section');
      section = item.section;
    }
    const start = lines.length;
    const marker = index === overlay.selected ? '›' : ' ';
    const badge = item.badge ? `  [${item.badge}]` : '';
    lines.push(...wrapTerminalLine(`${item.label}${badge}`, width, `${marker} `, '  '));
    if (item.detail) lines.push(...wrap(`    ${item.detail}`, width));
    for (let row = start; row < lines.length; row += 1) {
      targets.set(row, { type: 'overlay-item', index });
      lineKinds.set(row, `overlay:item${index === overlay.selected ? ':selected' : ''}`);
    }
  }
  return lines;
}

function visibleOverlayStart(overlay, targets, room, lineCount) {
  let start = Math.min(overlay.offset, Math.max(0, lineCount - room));
  const selectedRows = [...targets.entries()]
    .filter(([, target]) => target.type === 'overlay-item' && target.index === overlay.selected)
    .map(([row]) => row);
  if (selectedRows.length === 0) return start;
  const first = Math.min(...selectedRows);
  const last = Math.max(...selectedRows);
  if (first < start) start = first;
  else if (last >= start + room) start = last - room + 1;
  return Math.max(0, Math.min(start, Math.max(0, lineCount - room)));
}

function helpLines(width, bindings, session) {
  const lines = [crop(`COMMANDS  —  Esc or ${keyLabel(bindings.help)} returns to the conversation`, width)];
  lines.push(...bindingHelpLines(bindings).flatMap((line) => wrap(line, width)));
  for (const [category, commands] of commandsByCategory()) {
    lines.push('', crop(category.toUpperCase(), width));
    for (const item of commands.map((command) => commandPresentation(command, session, bindings))) {
      const binding = item.effectiveBinding ? ` · ${keyLabel(item.effectiveBinding)}` : '';
      const availability = item.available ? '' : ` · unavailable: ${item.unavailableReason}`;
      lines.push(...wrap(`  ${item.usage}${binding}  ${item.description} · requires ${item.requiredCapability}${availability}`, width));
    }
  }
  return lines;
}
function bindingHelpLines(bindings) {
  const labels = (names) => names.map((name) => `${name.replaceAll('_', ' ')} ${keyLabel(bindings[name])}`).join(' · ');
  return [
    `KEYS  ${labels(['submit', 'newline', 'cancel', 'help', 'undo', 'reset_keys'])}`,
    `SESSIONS  ${labels(['new_tab', 'close_tab', 'previous_tab', 'next_tab'])}`,
    `VIEW  ${labels(['toggle_activity', 'scroll_page_up', 'scroll_page_down', 'scroll_bottom', 'cycle_review'])}`,
  ];
}

function recordLines(record, width) {
  if (record.type === 'attachment_status') return wrap(`  ATTACHMENT | ${record.attachment_id ?? ''} | ${record.state} | ${record.guidance ?? ''}`, width);
  if (record.type === 'user_input') return renderMarkdown(record.text, width, '> ', '  ');
  if (record.type === 'stream_delta') return renderMarkdown(record.text, width, '* ', '  ');
  if (record.type === 'tool_status') {
    if (record.tool === 'agent.run' && ['running', 'succeeded'].includes(record.status)) return [];
    const outcome = toolOutcome(record);
    return wrapIndentedTerminalLine(`    ${toolSymbol(record.status)} ${record.tool}${toolTargetSuffix(record)} | ${outcome}`, width);
  }
  if (record.type === 'subagent_progress') return subagentProgressLines(record, width);
  if (record.type === 'review_status') return record.outcome === 'approve' ? [] : wrap(`    X REVIEW | ${record.outcome} | ${record.reason_code ?? ''}`, width);
  if (record.type === 'error') return wrap(`! ERROR ${record.code} | ${record.message}`, width);
  if (record.type === 'memory_status' || record.type === 'mcp_status') {
    if (record.status === 'ready') return [];
    return wrap(`  DEPENDENCY | ${record.status} | ${record.reason ?? record.id ?? ''}`, width);
  }
  if (record.type === 'skill_status') return wrap(`  SKILL | ${record.status} | ${record.code ?? ''} | ${record.path ?? ''}`, width);
  if (record.type === 'local_status') return wrap(`  ${record.kind.toUpperCase()} | ${record.text}`, width);
  if (record.type === 'queue_status') return wrap(`... WAITING FOR PROVIDER | position ${record.position}`, width);
  if (record.type === 'state_status') return [];
  if (record.type === 'context_compaction_status') return wrap(contextCompactionText(record), width);
  return [];
}

function toolOutcome(record) {
  if (record.status === 'review_pending') return 'awaiting review';
  if (record.status === 'approved') return 'approved';
  if (record.status === 'running') return 'running';
  if (record.status === 'completed_nonzero') return `completed · exit ${record.exit_code ?? 'nonzero'}`;
  return `${record.status}${toolFailureSuffix(record)}`;
}

function editorLines(session, width) {
  const editor = session.editor;
  const range = editor.selection();
  const before = editor.text.slice(0, range.start);
  const selected = editor.text.slice(range.start, range.end);
  const after = editor.text.slice(range.end);
  const attachmentCount = session.pendingAttachments?.length ?? 0;
  const attachmentMarker = attachmentCount > 0
    ? `[pasted ${attachmentCount} image${attachmentCount === 1 ? '' : 's'}] ` : '';
  const value = `${attachmentMarker}${before}${selected ? `⟦${selected}⟧` : '|'}${after}`;
  const lines = value.split('\n').flatMap((line) => wrap(line, Math.max(1, width - 2)));
  return lines.slice(-4).map((line, index) => crop(`${index === 0 ? '> ' : '  '}${line}`, width));
}

function controlLine(session, bindings) {
  const cancel = keyLabel(bindings.cancel);
  const help = keyLabel(bindings.help);
  const view = session.viewportEnd === null ? 'PgUp scroll' : 'PgDn scroll · End follow';
  const work = session.work?.goal || session.work?.tasks?.length
    ? ` · Click GOAL to ${session.workCollapsed ? 'expand' : 'collapse'}` : '';
  if (session.activeTurnId) return `Enter steer${work} · ${view} · double ${cancel} cancel · ${help} help`;
  if (session.viewportEnd !== null) return `Enter send${work} · ${view} · ${help} help`;
  const hasConversation = [...session.historyRecords, ...session.records]
    .some((record) => ['user_input', 'stream_delta'].includes(record.type));
  return hasConversation
    ? `Enter send${work} · ${help} help`
    : `Enter send${work} · Ctrl+J newline · Ctrl+O activity · ${view} · ${help} help`;
}

function tabLabel(session, activeId) {
  const selected = session.id === activeId ? (session.role === 'primary' ? '*' : '@') : session.unread ? '+' : ' ';
  const state = tabState(session);
  const authority = session.role === 'primary' ? ' *' : '';
  return `[${selected} ${sanitizeTerminal(session.name ?? 'Conversation').slice(0, 18)}${state}${authority}]`;
}

function visibleContentStart(options) {
  if (options.pendingPermission) return options.permissionStart;
  if (options.overlay) return options.overlayStart;
  if (options.help) return 0;
  return Math.max(0, options.viewportEnd - options.room);
}

function tabState(session) {
  if (session.state === 'failed') return '!';
  if (session.state === 'needs_input' || session.state === 'awaiting_approval') return '?';
  if (session.activeTurnId) return '~';
  return '';
}

function isActivity(record) {
  return ['tool_status', 'review_status', 'state_status', 'queue_status', 'subagent_progress'].includes(record.type);
}

function activityByTurn(records, completed) {
  const result = new Map();
  for (const record of records) {
    if (!isActivity(record) || !completed.has(record.turn_id)) continue;
    const values = result.get(record.turn_id) ?? [];
    values.push(record);
    result.set(record.turn_id, values);
  }
  return result;
}

function summarizeActivity(records) {
  const tools = new Map();
  const reviews = new Set();
  let engine = false;
  for (const record of records) {
    const id = record.tool_request_id ?? record.provider_call_id;
    if (record.type === 'tool_status') tools.set(id ?? record.tool ?? `tool:${tools.size}`, record.tool);
    if (record.type === 'review_status') reviews.add(id ?? record.decision_id ?? `review:${reviews.size}`);
    if (record.type === 'state_status' || record.type === 'queue_status') engine = true;
  }
  return { tools, reviews, engine };
}

function keyLabel(value) {
  if (!value) return 'unbound';
  return value.split('+').map((part) => part.length === 1 ? part.toUpperCase() : `${part[0].toUpperCase()}${part.slice(1)}`).join('+');
}

function turnReceipt(record, summary, mode, width) {
  const toolCount = summary.tools.size;
  const reviewCount = summary.reviews.size;
  const successful = record.outcome === 'completed';
  const marker = successful ? '*' : record.outcome === 'cancelled' ? '-'
    : record.outcome === 'needs_input' ? '?' : '!';
  const label = successful ? 'Turn finished' : record.outcome === 'cancelled'
    ? 'Turn cancelled' : record.outcome === 'needs_input' ? 'Turn needs input'
      : record.outcome === 'incomplete' ? 'Turn ended without completion'
      : `Turn ${record.outcome.replaceAll('_', ' ')}`;
  if (successful || record.outcome === 'needs_input') {
    const basic = [
      Number.isFinite(record.elapsed_ms) ? formatDuration(record.elapsed_ms) : null,
      receiptTokenText(record),
      toolCount ? `${toolCount} tool${toolCount === 1 ? '' : 's'}` : null,
      reviewCount ? `${reviewCount} review${reviewCount === 1 ? '' : 's'}` : null,
      toolCount || reviewCount ? `Ctrl+O ${mode === 'details' ? 'collapse' : 'details'}` : null,
    ].filter(Boolean);
    return wrap(`  ${marker}${basic.length ? ` ${basic.join(' | ')}` : ''}`, width);
  }
  const details = [
    Number.isFinite(record.elapsed_ms) ? formatDuration(record.elapsed_ms) : null,
    detailedTokenText(record),
    toolCount || reviewCount ? `${toolCount} tool${toolCount === 1 ? '' : 's'}` : 'direct response',
    reviewCount ? `${reviewCount} review${reviewCount === 1 ? '' : 's'}` : null,
    record.failure?.code ? `code ${record.failure.code}` : null,
    recoveryAction(record),
    toolCount || reviewCount ? `Ctrl+O ${mode === 'details' ? 'collapse' : 'details'}` : null,
  ].filter(Boolean);
  return wrap(`  ${marker} ${label}${details.length ? ` | ${details.join(' | ')}` : ''}`, width);
}
function recoveryAction(record) {
  if (record.outcome === 'needs_input') return null;
  if (record.outcome === 'incomplete') return 'review the explanation above';
  if (record.retryable) return 'retry: Up then Enter';
  if (!['completed', 'cancelled'].includes(record.outcome)) return 'inspect: /health';
  return null;
}

function formatDuration(milliseconds) {
  if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`;
  const seconds = milliseconds / 1000;
  return seconds < 60 ? `${seconds.toFixed(seconds < 10 ? 1 : 0)}s` : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}
function padCells(value, width) {
  return `${value}${' '.repeat(Math.max(0, width - displayWidth(value)))}`;
}

function wrap(value, width) {
  return String(value).split(/\r?\n/u).flatMap((line) => wrapIndentedTerminalLine(line, width)).slice(0, 64);
}

function crop(value, width) {
  return truncateTerminal(sanitizeTerminal(value), width);
}

function rule(width) {
  return '─'.repeat(width);
}
