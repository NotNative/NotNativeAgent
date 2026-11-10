// SPDX-License-Identifier: Apache-2.0
// The per-conversation fields of a session engine, held as one swappable
// object. Everything else a SessionEngine carries is workspace configuration
// or a shareable handle; only these fields belong to a single conversation.
// Why a dedicated class: the central-engine architecture resolves a session
// reference to conversation state; isolating the fields here is the seam that
// makes an engine able to carry many conversations instead of being one.
import { LifecycleRegistry, StateAuthority } from '../lifecycle.js';
import { AuthorityRecord } from '../authority.js';
import { ContractError } from '../ids.js';

export class ConversationState {
  state = new StateAuthority();
  lifecycles = new LifecycleRegistry();
  authority = new AuthorityRecord();
  transcript = [];
  steering = [];
  latestTurnOutcome = null;
  recoveryNotices = [];
  active = null;
}

/** The session-id to conversation-state registry a resident engine resolves
 *  through. Why owned by the engine host rather than a module map: lifecycle
 *  stays explicit — a conversation is attached when its state enters the map
 *  and detached when the host removes it, never by garbage collection. */
export class ConversationRegistry {
  #states = new Map();

  attach(sessionId, state = new ConversationState()) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new ContractError('session_id_invalid', 'a conversation identity is required');
    }
    if (this.#states.has(sessionId)) {
      throw new ContractError('session_duplicate', `conversation ${sessionId} is already attached`);
    }
    this.#states.set(sessionId, state);
    return state;
  }

  resolve(sessionId) {
    const state = this.#states.get(sessionId);
    if (!state) throw new ContractError('session_missing', `conversation ${sessionId} is not attached`);
    return state;
  }

  detach(sessionId) {
    if (!this.#states.delete(sessionId)) {
      throw new ContractError('session_missing', `conversation ${sessionId} is not attached`);
    }
  }

  has(sessionId) { return this.#states.has(sessionId); }
  ids() { return [...this.#states.keys()]; }
  size() { return this.#states.size; }
}
