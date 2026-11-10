// SPDX-License-Identifier: Apache-2.0
// The per-conversation fields of a session engine, held as one swappable
// object. Everything else a SessionEngine carries is workspace configuration
// or a shareable handle; only these fields belong to a single conversation.
// Why a dedicated class: the central-engine architecture resolves a session
// reference to conversation state; isolating the fields here is the seam that
// makes an engine able to carry many conversations instead of being one.
import { LifecycleRegistry, StateAuthority } from '../lifecycle.js';
import { AuthorityRecord } from '../authority.js';

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
