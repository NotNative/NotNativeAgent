// SPDX-License-Identifier: Apache-2.0
import { ContractError, newId } from './ids.js';

const MAX_TRANSITION_HISTORY = 4_096;

const TRANSITIONS = Object.freeze({
  idle: ['preparing_turn', 'shutting_down'],
  preparing_turn: ['invoking_model', 'compacting_context', 'finalizing_turn', 'cancelling'],
  compacting_context: ['invoking_model', 'finalizing_turn', 'cancelling'],
  invoking_model: ['streaming_model', 'recovering', 'finalizing_turn', 'cancelling'],
  streaming_model: ['validating_tool_requests', 'evaluating_completion', 'recovering', 'finalizing_turn', 'cancelling'],
  validating_tool_requests: ['awaiting_tool_approval', 'executing_tools', 'processing_tool_results', 'finalizing_turn', 'cancelling'],
  awaiting_tool_approval: ['executing_tools', 'processing_tool_results', 'cancelling'],
  executing_tools: ['processing_tool_results', 'cancelling'],
  processing_tool_results: ['preparing_continuation', 'finalizing_turn', 'cancelling'],
  preparing_continuation: ['invoking_model', 'compacting_context', 'finalizing_turn', 'cancelling'],
  evaluating_completion: ['preparing_continuation', 'recovering', 'finalizing_turn', 'cancelling'],
  recovering: ['invoking_model', 'compacting_context', 'preparing_continuation', 'finalizing_turn', 'cancelling'],
  cancelling: ['finalizing_turn'],
  finalizing_turn: ['idle'],
  shutting_down: [],
});

export class StateAuthority {
  #state = 'idle';
  #transitions = [];
  observer = null;

  get state() { return this.#state; }
  get transitions() { return Object.freeze([...this.#transitions]); }

  setObserver(observer) {
    this.observer = observer ?? null;
  }

  transition(to, context) {
    const from = this.#state;
    const allowed = TRANSITIONS[from]?.includes(to) === true;
    const fact = Object.freeze({
      id: newId('transition'), from, to, trigger: context.trigger,
      turnId: context.turnId ?? null, guard: allowed ? 'passed' : 'rejected',
    });
    this.#transitions.push(fact);
    if (this.#transitions.length > MAX_TRANSITION_HISTORY) this.#transitions.shift();
    observe(this.observer, 'transitionStarted', fact);
    if (!allowed) {
      observe(this.observer, 'transitionFinished', fact, 'rejected');
      throw new ContractError('illegal_transition', `${from} cannot transition to ${to}`);
    }
    try {
      context.exitEffect?.(from);
      this.#state = to;
      context.entryEffect?.(to);
    } catch (error) {
      observe(this.observer, 'transitionFailed', fact, error);
      if (this.#state !== to) throw error;
      // Entry owns the destination state; recovery must clean up from that committed state.
      throw new TransitionEntryError(fact, error);
    }
    observe(this.observer, 'transitionFinished', fact, 'succeeded');
    return fact;
  }
}

export class LifecycleRegistry {
  #records = new Map();
  #activeChildren = new Map();
  observer = null;

  setObserver(observer) {
    this.observer = observer ?? null;
  }

  start(kind, parentId = null) {
    const parent = parentId === null ? null : this.#records.get(parentId);
    if (parentId !== null && !parent) {
      throw new ContractError('missing_parent', 'lifecycle parent does not exist');
    }
    if (parent && parent.outcome !== null) throw new ContractError('terminal_parent', 'lifecycle parent is already terminal');
    const record = { id: newId(kind), kind, parentId, phase: 'active', outcome: null };
    this.#records.set(record.id, record);
    if (parentId !== null) this.#activeChildren.set(parentId, (this.#activeChildren.get(parentId) ?? 0) + 1);
    const snapshot = Object.freeze({ ...record });
    observe(this.observer, 'lifecycleStarted', snapshot);
    return snapshot;
  }

  finish(id, outcome) {
    if (typeof id !== 'string' || id.length === 0) throw new ContractError('lifecycle_id_invalid', 'lifecycle id is required');
    if (typeof outcome !== 'string' || outcome.length === 0) throw new ContractError('lifecycle_outcome_invalid', 'lifecycle outcome is required');
    const record = this.#records.get(id);
    if (!record || record.outcome !== null) {
      throw new ContractError('lifecycle_already_terminal', 'lifecycle cannot finish twice');
    }
    if ((this.#activeChildren.get(id) ?? 0) > 0) throw new ContractError('active_child', 'child must finish before parent');
    record.phase = 'terminal';
    record.outcome = outcome;
    if (record.parentId !== null) {
      const remaining = (this.#activeChildren.get(record.parentId) ?? 1) - 1;
      if (remaining === 0) this.#activeChildren.delete(record.parentId);
      else this.#activeChildren.set(record.parentId, remaining);
    }
    const snapshot = Object.freeze({ ...record });
    observe(this.observer, 'lifecycleFinished', snapshot);
    return snapshot;
  }

  snapshot() {
    return [...this.#records.values()].map((item) => Object.freeze({ ...item }));
  }
}

function observe(observer, method, ...args) {
  try { observer?.[method]?.(...args); } catch { /* observability cannot affect execution */ }
}

const TOOL_TRANSITIONS = Object.freeze({
  proposed: ['invalid', 'review_pending'],
  review_pending: ['approved', 'denied_with_guidance', 'hard_denied', 'escalation_pending'],
  approved: ['running', 'failed'],
  running: ['succeeded', 'failed', 'timed_out', 'cancelled', 'unknown_effect'],
  invalid: [], denied_with_guidance: [], hard_denied: [], escalation_pending: [],
  succeeded: [], failed: [], timed_out: [], cancelled: [], unknown_effect: [],
});

export class ToolChildState {
  #state = 'proposed';

  get state() { return this.#state; }

  move(next) {
    if (!TOOL_TRANSITIONS[this.#state]?.includes(next)) {
      throw new ContractError('illegal_tool_transition', `${this.#state} cannot transition to ${next}`);
    }
    this.#state = next;
    return next;
  }
}

class TransitionEntryError extends Error {
  constructor(transition, cause) {
    super(`entry effect failed after transition to ${transition.to}`, { cause });
    this.name = 'TransitionEntryError';
    this.transition = transition;
  }
}
