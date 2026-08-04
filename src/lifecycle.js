// SPDX-License-Identifier: Apache-2.0
import { ContractError, newId } from './ids.js';

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
  state = 'idle';
  transitions = [];
  observer = null;

  setObserver(observer) {
    this.observer = observer ?? null;
  }

  transition(to, context) {
    const from = this.state;
    const allowed = TRANSITIONS[from]?.includes(to) === true;
    const fact = Object.freeze({
      id: newId('transition'), from, to, trigger: context.trigger,
      turnId: context.turnId ?? null, guard: allowed ? 'passed' : 'rejected',
    });
    this.transitions.push(fact);
    observe(this.observer, 'transitionStarted', fact);
    if (!allowed) {
      observe(this.observer, 'transitionFinished', fact, 'rejected');
      throw new ContractError('illegal_transition', `${from} cannot transition to ${to}`);
    }
    try {
      context.exitEffect?.(from);
      this.state = to;
      context.entryEffect?.(to);
    } catch (error) {
      observe(this.observer, 'transitionFailed', fact, error);
      if (this.state !== to) throw error;
      throw new TransitionEntryError(fact, error);
    }
    observe(this.observer, 'transitionFinished', fact, 'succeeded');
    return fact;
  }
}

export class LifecycleRegistry {
  #records = new Map();
  observer = null;

  setObserver(observer) {
    this.observer = observer ?? null;
  }

  start(kind, parentId = null) {
    if (parentId !== null && !this.#records.has(parentId)) {
      throw new ContractError('missing_parent', 'lifecycle parent does not exist');
    }
    const record = { id: newId(kind), kind, parentId, phase: 'active', outcome: null };
    this.#records.set(record.id, record);
    observe(this.observer, 'lifecycleStarted', record);
    return Object.freeze({ ...record });
  }

  finish(id, outcome) {
    const record = this.#records.get(id);
    if (!record || record.outcome !== null) {
      throw new ContractError('lifecycle_already_terminal', 'lifecycle cannot finish twice');
    }
    const activeChild = [...this.#records.values()].find((item) => (
      item.parentId === id && item.outcome === null
    ));
    if (activeChild) throw new ContractError('active_child', 'child must finish before parent');
    record.phase = 'terminal';
    record.outcome = outcome;
    observe(this.observer, 'lifecycleFinished', record);
    return Object.freeze({ ...record });
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
  state = 'proposed';

  move(next) {
    if (!TOOL_TRANSITIONS[this.state]?.includes(next)) {
      throw new ContractError('illegal_tool_transition', `${this.state} cannot transition to ${next}`);
    }
    this.state = next;
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
