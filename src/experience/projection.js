// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';
export { validateKeyBindings } from './key-bindings.js';
import { validateKeyBindings } from './key-bindings.js';

const TUI_RECORD_LIMIT = 9_999;

const STATES = new Set([
  'idle', 'preparing', 'waiting_provider', 'streaming', 'awaiting_approval',
  'running_tool', 'recovering', 'cancelling', 'failed', 'needs_input',
]);

export class EditorBuffer {
  constructor(limit = 131_072) {
    this.text = '';
    this.cursor = 0;
    this.limit = limit;
    this.history = [];
    this.historyIndex = 0;
    this.anchor = null;
    this.undoStack = [];
  }

  insert(value) {
    const range = this.selection();
    const next = this.text.slice(0, range.start) + value + this.text.slice(range.end);
    if (Buffer.byteLength(next) > this.limit) {
      throw new ContractError('editor_limit', 'editor input exceeds its byte limit');
    }
    if (next === this.text) return;
    this.#checkpoint();
    this.text = next;
    this.cursor = range.start + value.length;
    this.anchor = null;
  }

  backspace() {
    if (this.#deleteSelection()) return;
    if (this.cursor === 0) return;
    this.#checkpoint();
    const start = previousCodePoint(this.text, this.cursor);
    this.text = this.text.slice(0, start) + this.text.slice(this.cursor);
    this.cursor = start;
  }

  delete() {
    if (this.#deleteSelection() || this.cursor === this.text.length) return;
    this.#checkpoint();
    const end = nextCodePoint(this.text, this.cursor);
    this.text = this.text.slice(0, this.cursor) + this.text.slice(end);
  }

  move(delta, selecting = false) {
    this.#beginMove(selecting);
    const direction = Math.sign(delta);
    for (let count = 0; count < Math.abs(delta); count += 1) {
      this.cursor = direction < 0
        ? previousCodePoint(this.text, this.cursor) : nextCodePoint(this.text, this.cursor);
    }
    this.#finishMove(selecting);
  }

  moveLine(edge, selecting = false) {
    this.#beginMove(selecting);
    const start = this.text.lastIndexOf('\n', Math.max(0, this.cursor - 1)) + 1;
    const end = this.text.indexOf('\n', this.cursor);
    this.cursor = edge === 'start' ? start : end < 0 ? this.text.length : end;
    this.#finishMove(selecting);
  }

  moveVertical(direction, selecting = false) {
    this.#beginMove(selecting);
    const start = this.text.lastIndexOf('\n', Math.max(0, this.cursor - 1)) + 1;
    const column = this.cursor - start;
    if (direction < 0 && start > 0) {
      const priorEnd = start - 1;
      const priorStart = this.text.lastIndexOf('\n', Math.max(0, priorEnd - 1)) + 1;
      this.cursor = Math.min(priorStart + column, priorEnd);
    } else if (direction > 0) {
      const end = this.text.indexOf('\n', this.cursor);
      if (end >= 0) {
        const nextEnd = this.text.indexOf('\n', end + 1);
        this.cursor = Math.min(end + 1 + column, nextEnd < 0 ? this.text.length : nextEnd);
      }
    }
    this.#finishMove(selecting);
  }

  moveWord(direction, selecting = false) {
    this.#beginMove(selecting);
    this.cursor = direction < 0 ? wordBoundaryLeft(this.text, this.cursor) : wordBoundaryRight(this.text, this.cursor);
    this.#finishMove(selecting);
  }

  undo() {
    const prior = this.undoStack.pop();
    if (!prior) return false;
    this.text = prior.text; this.cursor = prior.cursor; this.anchor = prior.anchor;
    return true;
  }

  selection() {
    return this.anchor === null
      ? { start: this.cursor, end: this.cursor }
      : { start: Math.min(this.anchor, this.cursor), end: Math.max(this.anchor, this.cursor) };
  }

  set(value) {
    const text = String(value);
    if (Buffer.byteLength(text) > this.limit) {
      throw new ContractError('editor_limit', 'editor input exceeds its byte limit');
    }
    this.text = text;
    this.cursor = this.text.length;
    this.anchor = null;
  }

  take() {
    const value = this.text;
    if (value.trim()) {
      this.history.push(value);
      if (this.history.length > 256) this.history.shift();
    }
    this.historyIndex = this.history.length;
    this.set('');
    return value;
  }

  navigateHistory(delta) {
    if (this.history.length === 0) return;
    this.historyIndex = Math.max(0, Math.min(this.history.length, this.historyIndex + delta));
    this.set(this.history[this.historyIndex] ?? '');
  }

  isNavigatingHistory() {
    return this.historyIndex < this.history.length
      && this.text === this.history[this.historyIndex];
  }

  #deleteSelection() {
    const range = this.selection();
    if (range.start === range.end) return false;
    this.#checkpoint();
    this.text = this.text.slice(0, range.start) + this.text.slice(range.end);
    this.cursor = range.start;
    this.anchor = null;
    return true;
  }

  #beginMove(selecting) {
    if (selecting && this.anchor === null) this.anchor = this.cursor;
    if (!selecting) this.anchor = null;
  }

  #finishMove(selecting) {
    this.cursor = Math.max(0, Math.min(this.text.length, this.cursor));
    if (!selecting || this.anchor === this.cursor) this.anchor = null;
  }

  #checkpoint() {
    this.undoStack.push({ text: this.text, cursor: this.cursor, anchor: this.anchor });
    if (this.undoStack.length > 128) this.undoStack.shift();
  }
}

export class TuiProjection {
  constructor(limit = TUI_RECORD_LIMIT) {
    this.limit = limit;
    this.sessions = new Map();
    this.activeId = null;
    this.focus = 'editor';
    this.help = false;
    this.overlay = null;
    this.mouseTargets = Object.freeze([]);
    this.visibleFrame = Object.freeze([]);
    this.terminalSelection = null;
    this.selectionDocumentLines = [];
    this.selectionRowMap = new Map();
    this.selectionContentBounds = null;
    this.notice = null;
    this.updateAvailable = false;
    this.bindings = validateKeyBindings();
  }

  addSession(id, name, metadata, role = undefined) {
    if (this.sessions.size >= 8) throw new ContractError('tui_session_limit', 'interactive session limit reached');
    role ??= this.sessions.size === 0 ? 'primary' : 'standard';
    if (!['primary', 'standard'].includes(role)) throw new ContractError('tui_session_role', 'invalid session role');
    if (role === 'primary' && [...this.sessions.values()].some((session) => session.role === 'primary')) {
      throw new ContractError('tui_primary_duplicate', 'only one Main authority tab may be attached');
    }
    this.sessions.set(id, {
      id, name, metadata, role,
      state: 'idle', records: [], editor: new EditorBuffer(), unread: false,
      pendingPermission: null, permissionOffset: 0, activeTurnId: null, confirmClose: false, confirmClear: false,
      viewportEnd: null, viewportLineCount: 0, expandedTurns: new Set(), detailedTurns: new Set(), usage: null,
      contextBytes: 0, contextLimitBytes: null, contextTokens: null, rawContextTokens: null, contextLimitTokens: null,
      contextThresholdTokens: null, contextOutputReserveTokens: null,
      contextCompressionThresholdTokens: null, contextCompressionThreshold: null,
      contextCompressionLevel2ThresholdTokens: null, contextCompressionLevel2Threshold: null,
      contextCompressionLevel3ThresholdTokens: null, contextCompressionLevel3Threshold: null,
      contextCompactionThreshold: null, contextCompaction: null, lastContextReduction: null,
      commandSuggestionIndex: 0, commandSuggestionItems: null,
      contextParallelCapacity: null, contextMeasurement: null, contextSource: null,
      lastOutcome: null, turnStartedAt: null, reviewPosture: 'auto-review', pendingAttachments: [],
      historyRecords: [], beforeSequence: null, hasMore: false, historyAnchor: null,
      work: null, workCollapsed: false,
    });
    this.activeId ??= id;
  }

  activate(id) {
    if (!this.sessions.has(id)) throw new ContractError('tui_session_missing', 'session does not exist');
    this.activeId = id;
    this.sessions.get(id).unread = false;
  }

  cycleActive(delta) {
    const ids = [...this.sessions.keys()];
    if (ids.length < 2) return;
    const current = Math.max(0, ids.indexOf(this.activeId));
    this.activate(ids[(current + delta + ids.length) % ids.length]);
  }

  activateIndex(index) {
    const id = [...this.sessions.keys()][index];
    if (id) this.activate(id);
  }

  remove(id) {
    this.sessions.delete(id);
    if (this.activeId === id) this.activeId = this.sessions.keys().next().value ?? null;
  }

  apply(id, event) {
    const session = this.sessions.get(id);
    if (!session) return;
    const observed = observedEvent(session, event);
    applyEvent(session, observed);
    const prior = session.records.at(-1);
    if (observed.type === 'stream_delta' && prior?.type === 'stream_delta') {
      session.records[session.records.length - 1] = Object.freeze({
        ...prior, ...observed, text: `${prior.text ?? ''}${observed.text ?? ''}`,
      });
    } else {
      session.records.push(Object.freeze(observed));
    }
    if (session.records.length > this.limit) session.records.splice(0, session.records.length - this.limit);
    if (id !== this.activeId && visibleEvent(observed)) session.unread = true;
  }

  active() {
    return this.sessions.get(this.activeId) ?? null;
  }

  scrollActive(delta) {
    const session = this.active();
    if (!session) return;
    const end = session.viewportEnd ?? session.viewportLineCount;
    const next = Math.max(0, Math.min(session.viewportLineCount, end + delta));
    session.viewportEnd = next >= session.viewportLineCount ? null : next;
  }

  followActive() {
    const session = this.active();
    if (session) session.viewportEnd = null;
  }

  prependHistory(id, records) {
    const session = this.sessions.get(id);
    if (!session || records.length === 0) return false;
    session.historyAnchor = { lineCount: session.viewportLineCount, end: session.viewportEnd ?? 0 };
    session.historyRecords.unshift(...records.map((record) => Object.freeze(record)));
    if (session.historyRecords.length > TUI_RECORD_LIMIT) {
      session.historyRecords.splice(0, session.historyRecords.length - TUI_RECORD_LIMIT);
    }
    return true;
  }

  toggleLatestActivity() {
    const session = this.active();
    if (!session) return false;
    const completed = new Set(session.records.filter((record) => record.type === 'turn_result').map((record) => record.turn_id));
    const turnId = [...session.records].reverse().find((record) => completed.has(record.turn_id)
      && ['tool_status', 'review_status'].includes(record.type))?.turn_id;
    if (!turnId) return false;
    toggleDetailedActivity(session, turnId);
    return true;
  }

  toggleActivity(turnId) {
    const session = this.active();
    if (!session) return false;
    const records = [...session.historyRecords, ...session.records];
    const completed = records.some((record) => record.type === 'turn_result' && record.turn_id === turnId);
    const hasActivity = records.some((record) => ['tool_status', 'review_status'].includes(record.type) && record.turn_id === turnId);
    if (!completed || !hasActivity) return false;
    if (session.detailedTurns.has(turnId)) return false;
    if (session.expandedTurns.has(turnId)) session.expandedTurns.delete(turnId);
    else session.expandedTurns.add(turnId);
    return true;
  }

  toggleWorkSummary() {
    const session = this.active();
    if (!session || (!session.work?.goal && !session.work?.tasks?.length)) return false;
    session.workCollapsed = !session.workCollapsed;
    return true;
  }

  showNotice(kind, text) {
    this.notice = Object.freeze({ kind, text });
  }

  clearNotice() {
    this.notice = null;
  }

  openOverlay(value) {
    this.help = false;
    this.overlay = Object.freeze({ ...value, offset: 0 });
  }

  closeOverlay() {
    this.overlay = null;
  }

  scrollOverlay(delta) {
    if (!this.overlay) return;
    this.overlay = Object.freeze({ ...this.overlay, offset: Math.max(0, this.overlay.offset + delta) });
  }

  moveOverlaySelection(delta) {
    if (!this.overlay?.items?.length) return;
    const length = this.overlay.items.length;
    const selected = (this.overlay.selected + delta + length) % length;
    this.overlay = Object.freeze({ ...this.overlay, selected });
  }

  selectOverlay(index) {
    if (!this.overlay?.items?.[index]) return false;
    this.overlay = Object.freeze({ ...this.overlay, selected: index });
    return true;
  }
}

function toggleDetailedActivity(session, turnId) {
  if (session.detailedTurns.has(turnId)) {
    session.detailedTurns.delete(turnId); session.expandedTurns.delete(turnId);
  } else {
    session.expandedTurns.add(turnId); session.detailedTurns.add(turnId);
  }
}

function applyEvent(session, event) {
  if (event.type === 'accepted' && event.accepted && event.turn_id) {
    const beginsNewTurn = session.activeTurnId !== event.turn_id || !Number.isFinite(session.turnStartedAt);
    session.state = 'preparing'; session.activeTurnId = event.turn_id;
    if (beginsNewTurn) session.turnStartedAt = Date.now();
  } else if (event.type === 'stream_delta') session.state = 'streaming';
  else if (event.type === 'review_status') session.state = 'awaiting_approval';
  else if (event.type === 'permission_prompt') {
    session.state = 'awaiting_approval'; session.pendingPermission = event; session.permissionOffset = 0;
  } else if (event.type === 'tool_status' && event.status === 'running') session.state = 'running_tool';
  else if (event.type === 'queue_status') session.state = 'waiting_provider';
  else if (event.type === 'state_status' && STATES.has(event.semantic_state)) session.state = event.semantic_state;
  else if (event.type === 'mcp_status') {
    if (event.status === 'ready' && session.commandCapabilities) session.commandCapabilities.mcpReady = true;
  } else if (event.type === 'memory_status') session.state = session.state;
  else if (event.type === 'work_status') session.work = event.work;
  else if (event.type === 'context_status') {
    session.contextBytes = event.bytes;
    session.contextLimitBytes = event.limit_bytes;
    session.contextTokens = event.estimated_tokens;
    session.rawContextTokens = event.raw_estimated_tokens;
    session.contextLimitTokens = event.limit_tokens;
    session.contextThresholdTokens = event.compaction_threshold_tokens;
    session.contextCompressionThresholdTokens = event.compression_threshold_tokens;
    session.contextCompressionLevel2ThresholdTokens = event.compression_level_2_threshold_tokens;
    session.contextCompressionLevel3ThresholdTokens = event.compression_level_3_threshold_tokens;
    session.contextCompressionThreshold = event.compression_threshold;
    session.contextCompressionLevel2Threshold = event.compression_level_2_threshold;
    session.contextCompressionLevel3Threshold = event.compression_level_3_threshold;
    session.contextCompactionThreshold = event.compaction_threshold;
    session.contextOutputReserveTokens = event.output_reserve_tokens;
    session.contextParallelCapacity = event.parallel_capacity;
    session.contextMeasurement = event.measurement;
    session.contextSource = event.source;
  } else if (event.type === 'context_usage') {
    session.contextBytes = event.current_bytes;
    if (Number.isFinite(event.limit_bytes)) session.contextLimitBytes = event.limit_bytes;
    session.rawContextTokens = event.current_estimated_tokens;
    if (Number.isFinite(event.limit_tokens)) session.contextLimitTokens = event.limit_tokens;
    session.contextMeasurement = event.measurement ?? session.contextMeasurement;
  } else if (event.type === 'context_compaction_status') {
    session.contextCompaction = event.status === 'started' ? {
      beforeTokens: event.before_estimated_tokens, targetTokens: event.target_tokens,
    } : null;
    if (event.status === 'completed') session.lastContextReduction = {
      beforeTokens: event.before_estimated_tokens, afterTokens: event.after_estimated_tokens,
    };
  }
  else if (event.type === 'turn_result') finishTurn(session, event);
  else if (event.type === 'error') session.state = 'failed';
  if (!STATES.has(session.state)) throw new ContractError('tui_projection_state', 'invalid projected state');
}

function finishTurn(session, event) {
  session.activeTurnId = null;
  session.pendingPermission = null;
  session.state = event.outcome === 'needs_input' ? 'needs_input'
    : event.outcome === 'failed' || event.outcome === 'limit_reached' ? 'failed' : 'idle';
  session.usage = accumulateUsage(session.usage, event.usage);
  session.lastOutcome = event.outcome;
  session.turnStartedAt = null;
  if (event.failure?.pending_text) session.editor.set(event.failure.pending_text);
}

function accumulateUsage(current, update) {
  if (!update || typeof update !== 'object') return current;
  const result = { ...(current ?? {}) };
  for (const [key, value] of Object.entries(update)) {
    if (Number.isFinite(value)) result[key] = (Number.isFinite(result[key]) ? result[key] : 0) + value;
  }
  return Object.freeze(result);
}

function observedEvent(session, event) {
  if (event.type !== 'turn_result' || Number.isFinite(event.elapsed_ms) || !Number.isFinite(session.turnStartedAt)) {
    return { ...event };
  }
  return { ...event, elapsed_ms: Math.max(0, Date.now() - session.turnStartedAt) };
}

function visibleEvent(event) {
  return !['accepted', 'state_status', 'context_status', 'context_usage'].includes(event.type);
}

function previousCodePoint(value, index) {
  if (index <= 0) return 0;
  const prior = value.charCodeAt(index - 1);
  return prior >= 0xdc00 && prior <= 0xdfff ? index - 2 : index - 1;
}

function nextCodePoint(value, index) {
  if (index >= value.length) return value.length;
  const current = value.charCodeAt(index);
  return current >= 0xd800 && current <= 0xdbff ? index + 2 : index + 1;
}

function wordBoundaryLeft(value, index) {
  let cursor = index;
  while (cursor > 0 && characterClass(value.slice(previousCodePoint(value, cursor), cursor)) === 'space') {
    cursor = previousCodePoint(value, cursor);
  }
  if (cursor === 0) return 0;
  const kind = characterClass(value.slice(previousCodePoint(value, cursor), cursor));
  while (cursor > 0) {
    const prior = previousCodePoint(value, cursor);
    if (characterClass(value.slice(prior, cursor)) !== kind) break;
    cursor = prior;
  }
  return cursor;
}

function wordBoundaryRight(value, index) {
  let cursor = index;
  while (cursor < value.length && characterClass(value.slice(cursor, nextCodePoint(value, cursor))) === 'space') {
    cursor = nextCodePoint(value, cursor);
  }
  if (cursor === value.length) return cursor;
  const kind = characterClass(value.slice(cursor, nextCodePoint(value, cursor)));
  while (cursor < value.length) {
    const next = nextCodePoint(value, cursor);
    if (characterClass(value.slice(cursor, next)) !== kind) break;
    cursor = next;
  }
  return cursor;
}

function characterClass(value) {
  if (/^\s$/u.test(value)) return 'space';
  return /^[\p{L}\p{N}_]$/u.test(value) ? 'word' : 'symbol';
}
