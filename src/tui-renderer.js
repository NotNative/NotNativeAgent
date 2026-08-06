// SPDX-License-Identifier: Apache-2.0
import { sanitizeTerminal } from './terminal-adapter.js';
import { commandPresentation, commandSuggestions, commandsByCategory } from './tui-commands.js';
import { VERSION } from './product.js';
import { activityDetailRows, collapsedFailureRows, summaryActivityRows, toolFailureSuffix, toolTargetSuffix } from './tui-activity-renderer.js';
import { angledWordmarkGradient, decorateOverlay } from './tui-colors.js';
import { displayWidth, renderMarkdown, truncateTerminal, wrapTerminalLine } from './terminal-markdown.js';
import { sessionStatusLine } from './tui-status-line.js';
import { decorateSelection, plainTerminalLine } from './tui-selection.js';
import { contextCompactionText } from './tui-context-renderer.js';
export class TuiRenderer {
  frame(projection, capabilities) {
    const session = projection.active();
    if (!session) return `NotNativeAgent ${VERSION}\n[IDLE] No conversation\n`;
    const width = Math.max(24, capabilities.width);
    const height = Math.max(8, capabilities.height);
    const header = headerLines(projection, session, width);
    const footer = footerLines(projection, session, width);
    const room = Math.max(1, height - header.length - footer.length);
    const targets = new Map();
    const available = contentLines(projection, session, width, targets);
    restoreHistoryAnchor(session, available.length);
    if (!session.pendingPermission && !projection.help && !projection.overlay) session.viewportLineCount = available.length;
    const permissionStart = Math.min(session.permissionOffset, Math.max(0, available.length - room));
    const viewportEnd = session.viewportEnd === null
      ? available.length : Math.min(session.viewportEnd, available.length);
    if (session.viewportEnd !== null && viewportEnd >= available.length) session.viewportEnd = null;
    const overlayStart = projection.overlay
      ? visibleOverlayStart(projection.overlay, targets, room, available.length)
      : 0;
    const contentStart = session.pendingPermission ? permissionStart
      : projection.overlay ? overlayStart
        : projection.help ? 0 : Math.max(0, viewportEnd - room);
    const content = available.slice(contentStart, contentStart + room);
    projection.selectionDocumentLines = available.map(plainTerminalLine);
    projection.selectionRowMap = new Map(content.map((_line, index) => [header.length + index + 1, contentStart + index]));
    projection.selectionContentBounds = { first: header.length + 1, last: header.length + content.length };
    projection.mouseTargets = Object.freeze([...targets.entries()]
      .filter(([index]) => index >= contentStart && index < contentStart + content.length)
      .map(([index, target]) => Object.freeze({ ...target, row: header.length + index - contentStart + 1 })));
    const color = capabilities.color === true;
    const frame = [
      ...header.map((line, index) => decorateHeader(line, index, color)),
      ...content.map((line, index) => decorateContent(line, width, color, index, projection.overlay?.kind)),
      ...footer.map((line, index) => decorateFooter(line, index, footer.length, color)),
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

function contentLines(projection, session, width, targets = new Map()) {
  if (session.pendingPermission) return permissionLines(session.pendingPermission, width);
  if (projection.overlay) return overlayLines(projection.overlay, width, targets);
  if (projection.help) return helpLines(width, projection.bindings, session);
  const lines = [...sessionBanner(session, width), ''];
  const records = [...session.historyRecords, ...session.records];
  const completed = new Set(records.filter((record) => record.type === 'turn_result').map((record) => record.turn_id));
  const activity = activityByTurn(records, completed);
  let lastVisibleKind = null;
  for (const record of records) {
    if (isActivity(record) && completed.has(record.turn_id)) continue;
    if (record.type === 'turn_result') {
      const records = activity.get(record.turn_id) ?? [];
      const summary = summarizeActivity(records);
      const mode = session.detailedTurns.has(record.turn_id) ? 'details'
        : session.expandedTurns.has(record.turn_id) ? 'summary' : 'collapsed';
      const start = lines.length;
      if (mode === 'details') lines.push(...activityDetailRows(records, width, wrap));
      else if (mode === 'summary') lines.push(...summaryActivityRows(records).flatMap((line) => wrap(line, width)));
      else lines.push(...collapsedFailureRows(records).flatMap((line) => wrap(line, width)));
      lines.push(...turnReceipt(record, summary, mode, width), '');
      for (let index = start; index < lines.length - 1; index += 1) targets.set(index, { type: 'activity', turnId: record.turn_id });
      lastVisibleKind = 'turn_result';
      continue;
    }
    const rendered = recordLines(record, width); if (rendered.length === 0) continue;
    if (record.type === 'stream_delta' && ['activity', 'stream_delta'].includes(lastVisibleKind)) {
      while (lines.at(-1) === '') lines.pop();
      lines.push('');
    }
    lines.push(...rendered); lastVisibleKind = isActivity(record) ? 'activity' : record.type;
  }
  return lines;
}

function restoreHistoryAnchor(session, nextLineCount) {
  if (!session.historyAnchor) return;
  const added = Math.max(0, nextLineCount - session.historyAnchor.lineCount);
  session.viewportEnd = Math.min(nextLineCount, session.historyAnchor.end + added);
  session.historyAnchor = null;
}

function sessionBanner(session, width) {
  const values = [
    ...wordmark(width),
    `NotNativeAgent · v${VERSION}`,
    '',
    `Provider   ${session.metadata.endpoint ?? session.metadata.provider}${session.metadata.temporaryRoute ? ' (temporary)' : ''}`,
    `Model      ${session.metadata.model}`,
    `Workspace  ${session.metadata.workspace ?? '--'}`,
    '',
    'Ready · type /help to browse commands',
  ];
  return [boxTop('NNA CONSOLE', width), ...values.map((line) => boxLine(line, width)), boxBottom(width)];
}

function wordmark(width) {
  if (width < 52) return [];
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

function footerLines(projection, session, width) {
  const lines = [rule(width)];
  if (session.pendingPermission) {
    lines.push(crop(`${keyLabel(projection.bindings.allow_once)} allow once · 2 same operation · 3 this tool in workspace · 4 deny · ${keyLabel(projection.bindings.cancel)} cancel`, width));
    lines.push(footerStatusLine(projection, session, width));
    return lines;
  }
  if (projection.overlay) {
    const action = projection.overlay.actionLabel
      ?? (projection.overlay.items?.length ? '↑↓ choose · Enter select' : '↑↓ scroll');
    lines.push(crop(`${action} · Esc back · Ctrl+G/Ctrl+C close · ${projection.overlay.kind}`, width));
    lines.push(footerStatusLine(projection, session, width));
    return lines;
  }
  if (projection.notice && projection.notice.kind !== 'confirmation') lines.push(crop(`[${projection.notice.kind.toUpperCase()}] ${projection.notice.text}`, width));
  const suggestions = commandSuggestions(session.editor.text, 3).map((item) => commandPresentation(item, session, projection.bindings));
  for (const item of suggestions) lines.push(crop(`${item.usage} — ${item.available ? item.description : `unavailable: ${item.unavailableReason}`}`, width));
  lines.push(...editorLines(session.editor, width));
  lines.push(rule(width));
  lines.push(crop(controlLine(session, projection.bindings), width));
  lines.push(footerStatusLine(projection, session, width));
  return lines;
}

function footerStatusLine(projection, session, width) {
  if (projection.notice?.kind === 'confirmation') return crop(projection.notice.text, width);
  return sessionStatusLine(session, width);
}

function permissionLines(record, width) {
  const values = [
    ['APPROVAL REQUIRED', `${record.tool}`], ['Action', record.action],
    ['Scope', record.scope], ['Effect', record.effect], ['Reversible', record.reversibility],
    ['Blast radius', record.blast_radius], ['Risk', `${record.risk}: ${record.reason_code}`],
    ['Reviewer', record.guidance], ['Arguments', JSON.stringify(record.arguments)],
    ['Expires', new Date(record.expires_at).toISOString()],
  ];
  const lines = [];
  for (const [label, value] of values) lines.push(...wrap(`${label}: ${value ?? 'not provided'}`, width));
  return lines;
}

function overlayLines(overlay, width, targets = new Map()) {
  const lines = [crop(overlay.title.toUpperCase(), width), rule(width)];
  if (overlay.tabs?.length) {
    const tabs = overlay.tabs.map((tab) => tab.active ? `[ ${tab.label.toUpperCase()} ]` : tab.label.toUpperCase()).join('   ');
    lines.push(crop(tabs, width), '');
  }
  for (const line of overlay.lines) lines.push(...wrap(line, width));
  let section = null;
  for (const [index, item] of (overlay.items ?? []).entries()) {
    if (item.section && item.section !== section) {
      lines.push('', crop(item.section.toUpperCase(), width));
      section = item.section;
    }
    const start = lines.length;
    const marker = index === overlay.selected ? '›' : ' ';
    const badge = item.badge ? `  [${item.badge}]` : '';
    lines.push(...wrap(`${marker} ${item.label}${badge}`, width));
    if (item.detail) lines.push(...wrap(`    ${item.detail}`, width));
    for (let row = start; row < lines.length; row += 1) targets.set(row, { type: 'overlay-item', index });
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
  if (record.type === 'tool_status') return record.status === 'running' ? [] : wrap(`    ${toolSymbol(record.status)} ${record.tool}${toolTargetSuffix(record)} | ${record.status}${toolFailureSuffix(record)}`, width);
  if (record.type === 'review_status') return record.outcome === 'approve' ? [] : wrap(`    X REVIEW | ${record.outcome} | ${record.reason_code ?? ''}`, width);
  if (record.type === 'error') return wrap(`! ERROR ${record.code} | ${record.message}`, width);
  if (record.type === 'memory_status' || record.type === 'mcp_status') return wrap(`  DEPENDENCY | ${record.status} | ${record.reason ?? record.id ?? ''}`, width);
  if (record.type === 'local_status') return wrap(`  ${record.kind.toUpperCase()} | ${record.text}`, width);
  if (record.type === 'queue_status') return wrap(`... WAITING FOR PROVIDER | position ${record.position}`, width);
  if (record.type === 'state_status') return [];
  if (record.type === 'context_compaction_status') return wrap(contextCompactionText(record), width);
  return [];
}

function editorLines(editor, width) {
  const range = editor.selection();
  const before = editor.text.slice(0, range.start);
  const selected = editor.text.slice(range.start, range.end);
  const after = editor.text.slice(range.end);
  const value = `${before}${selected ? `⟦${selected}⟧` : '|'}${after}`;
  const lines = value.split('\n').flatMap((line) => wrap(line, Math.max(1, width - 2)));
  return lines.slice(-4).map((line, index) => crop(`${index === 0 ? '> ' : '  '}${line}`, width));
}

function controlLine(session, bindings) {
  const cancel = keyLabel(bindings.cancel);
  const help = keyLabel(bindings.help);
  const view = session.viewportEnd === null ? 'PgUp scroll' : 'PgDn scroll · End follow';
  if (session.activeTurnId) return `Enter steer · Ctrl+J newline · ${view} · double ${cancel} cancel`;
  return `Enter send · Ctrl+J newline · Ctrl+O activity · ${view} · ${help} help`;
}

function tabLabel(session, activeId) {
  const selected = session.id === activeId ? (session.role === 'primary' ? '*' : '@') : session.unread ? '+' : ' ';
  const state = tabState(session);
  return `[${selected} ${sanitizeTerminal(session.name).slice(0, 18)}${state}]`;
}

function tabState(session) {
  if (session.state === 'failed') return '!';
  if (session.state === 'needs_input' || session.state === 'awaiting_approval') return '?';
  if (session.activeTurnId) return '~';
  return '';
}

function isActivity(record) {
  return ['tool_status', 'review_status', 'state_status', 'queue_status'].includes(record.type);
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

function toolSymbol(status) {
  return !status ? '-' : status === 'running' ? '+' : status === 'succeeded' ? '\u2713' : 'X';
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
      receiptTokens(record.usage),
      toolCount ? `${toolCount} tool${toolCount === 1 ? '' : 's'}` : null,
      reviewCount ? `${reviewCount} review${reviewCount === 1 ? '' : 's'}` : null,
      toolCount || reviewCount ? `Ctrl+O ${mode === 'collapsed' ? 'summary' : mode === 'summary' ? 'details' : 'collapse'}` : null,
    ].filter(Boolean);
    return wrap(`  ${marker}${basic.length ? ` ${basic.join(' | ')}` : ''}`, width);
  }
  const details = [
    Number.isFinite(record.elapsed_ms) ? formatDuration(record.elapsed_ms) : null,
    usageDetail(record.usage),
    toolCount || reviewCount ? `${toolCount} tool${toolCount === 1 ? '' : 's'}` : 'direct response',
    reviewCount ? `${reviewCount} review${reviewCount === 1 ? '' : 's'}` : null,
    record.failure?.code ? `code ${record.failure.code}` : null,
    recoveryAction(record),
    toolCount || reviewCount ? `Ctrl+O ${mode === 'collapsed' ? 'summary' : mode === 'summary' ? 'details' : 'collapse'}` : null,
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

function receiptTokens(usage) {
  const total = usage?.total_tokens ?? usage?.totalTokens;
  if (Number.isFinite(total)) return `${total} tokens`;
  const prompt = usage?.prompt_tokens;
  const completion = usage?.completion_tokens;
  return Number.isFinite(prompt) && Number.isFinite(completion) ? `${prompt + completion} tokens` : null;
}

function usageDetail(usage) {
  const prompt = usage?.prompt_tokens;
  const completion = usage?.completion_tokens;
  if (Number.isFinite(prompt) && Number.isFinite(completion)) return `${prompt} in + ${completion} out`;
  const total = usage?.total_tokens ?? usage?.totalTokens;
  return Number.isFinite(total) ? `${total} tokens` : null;
}

function formatDuration(milliseconds) {
  if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`;
  const seconds = milliseconds / 1000;
  return seconds < 60 ? `${seconds.toFixed(seconds < 10 ? 1 : 0)}s` : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}
function decorateHeader(line, index, color) {
  if (!color) return line;
  if (index > 0) return paint('38;5;238', line);
  let result = line.replace(/\[[^\]]+\]/gu, (tab) => {
    if (/^\[(?:\*|@)/u.test(tab)) return paint('1;38;5;255;48;5;54', tab);
    if (/^\[\+/u.test(tab)) return paint('1;38;5;213', tab);
    return paint('38;5;103', tab);
  });
  return result;
}
function decorateContent(line, width, color, index, overlayKind) {
  if (!color) return line;
  if (/^[╭╰]/u.test(line)) return paint('38;5;93', line);
  if (line.startsWith('│') && line.endsWith('│')) return decorateBanner(line, index);
  if (overlayKind) return decorateOverlay(line, width, overlayKind);
  if (line.startsWith('> ')) return paint('38;5;255;48;5;236', padCells(line, width));
  if (line.startsWith('* ')) return `${paint('1;38;5;213', '*')} ${line.slice(2)}`;
  if (/^\s*(?:STATE|REVIEW|DEPENDENCY|ATTACHMENT|\.\.\. WAITING FOR PROVIDER)\b/u.test(line)) {
    return paint('38;5;245', line);
  }
  if (/^\s+(?:Review|Result):/u.test(line)) return paint('38;5;245', line);
  const succeededTool = line.match(/^(\s*)(\u2713)(.*)$/u); if (succeededTool) return `${succeededTool[1]}${paint('38;5;77', succeededTool[2])}${paint('38;5;245', succeededTool[3])}`;
  if (/^\s+\+/u.test(line)) return paint('38;5;245', line);
  if (/^\s+X|^!/u.test(line)) return paint('38;5;203', line);
  if (/^\s+Activity summary/u.test(line)) return paint('38;5;245', line);
  if (/^\s+v Activity detail/u.test(line)) return paint('38;5;141', line);
  if (/^\s+[*-](?:\s|$)/u.test(line)) return paint('38;5;103', line);
  return line;
}

function decorateBanner(line, contentIndex) {
  const middle = line.slice(1, -1);
  const wordmark = /[█╗╔║═╝]/u.test(middle);
  const styled = wordmark ? angledWordmarkGradient(middle, contentIndex - 1) : middle;
  return `${paint('38;5;93', '│')}${styled}${paint('38;5;93', '│')}`;
}

function decorateFooter(line, index, length, color) {
  if (!color) return line;
  if (/^─+$/u.test(line)) return paint('38;5;238', line);
  if (index === length - 1) {
    const status = paint('38;5;103', line);
    return status.replace(/^(?:prompt|auto-review|unattended)/u, (posture) => paint('1;38;5;213', posture));
  }
  if (index === length - 2) return paint('38;5;244', line);
  if (line.startsWith('> ')) return `${paint('1;38;5;81', '>')} ${line.slice(2)}`;
  if (line.startsWith('/')) return paint('38;5;141', line);
  return line;
}

function padCells(value, width) {
  return `${value}${' '.repeat(Math.max(0, width - displayWidth(value)))}`;
}

function paint(codes, value) {
  return `\u001b[${codes}m${value}\u001b[0m`;
}

function wrap(value, width) {
  return String(value).split(/\r?\n/u).flatMap((line) => wrapTerminalLine(line, width)).slice(0, 64);
}

function crop(value, width) {
  return truncateTerminal(sanitizeTerminal(value), width);
}

function rule(width) {
  return '─'.repeat(width);
}
