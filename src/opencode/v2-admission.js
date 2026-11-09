// SPDX-License-Identifier: Apache-2.0
// Prompt-admission validation for the v2 workspace: the request-shape rules a
// prompt must satisfy before it touches an engine. Split from `v2-workspace.js`
// so the admission contract reads as one block and the workspace stays under
// its line budget.
import { apiError, invalid, objectInput, textInput, wireId } from './v2-contract.js';
import { physicalWireAllowance } from '../reliability/context-budget.js';

/** Bind the session's current state to an admission, refusing everything the
 *  wire contract does not accept.
 *
 *  Why the state guards here and not at the route: a closing or selecting
 *  session must refuse new work wherever the request enters, and the 409 shape
 *  is the same vocabulary the model switch answers. */
export function validatePromptAdmission(state, body, options) {
  if (state.closing) throw apiError(409, 'ConflictError', 'Session is closing');
  if (state.selecting) throw apiError(409, 'ConflictError', 'Model selection is in progress');
  // `synthetic` is set by the caller that already decided the admission is a
  // continuation, never by the request body, so it is not an accepted field.
  // Why the guard: destructuring a non-object would raise a TypeError before
  // validation, turning a rejected admission into a 500.
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('Expected a JSON object');
  const { synthetic = false, ...input } = body;
  objectInput(input, ['id', 'text', 'files', 'agents', 'skills', 'metadata', 'delivery', 'resume', 'description']);
  textInput(body.text, 'text', physicalWireAllowance(options.registry?.get(state.info.id)?.engine?.ingressContextWindowTokens ?? 65_536));
  for (const field of ['files', 'agents', 'skills']) {
    if (body[field] !== undefined && (!Array.isArray(body[field]) || body[field].length)) throw invalid(`${field} are not supported by this surface`);
  }
  // Compatibility: `resume: false` is how the client admits text that must not
  // open a turn — the goal briefing says so in as many words ("the model would
  // start on the briefing alone, before the task arrived"). Gold OC holds such
  // an admission and delivers it with the next scheduled turn, so NNA holds it
  // too: the text is journaled into the next turn as untrusted context, never
  // as an operator utterance, and never starts a turn of its own.
  if (body.resume != null && typeof body.resume !== 'boolean') throw invalid('resume must be a boolean');
  // Why the prompt route refuses it: prompt text is an operator task, and a
  // surface that cannot defer must say so rather than hold a task silently.
  // Holding it would deliver operator speech later as untrusted briefing
  // context, downgrading authority it earned and never running it. Every real
  // `resume: false` caller in the client posts to `/synthetic`.
  if (body.resume === false && !synthetic) throw invalid('Deferred execution is not supported by this surface');
  const held = synthetic && body.resume === false;
  if (body.delivery != null && !['queue', 'steer'].includes(body.delivery)) throw invalid('Invalid delivery mode');
  if (body.delivery === 'steer' && (state.running || state.pending.size)) throw apiError(409, 'ConflictError', 'Use queue delivery while NNA is running');
  validateMetadata(body.metadata);
  return { synthetic, held, id: wireId(body.id, 'msg') };
}

function validateMetadata(value) {
  if (value == null) return;
  if (typeof value !== 'object' || Array.isArray(value) || Buffer.byteLength(JSON.stringify(value)) > 16_384) throw invalid('metadata must be an object of at most 16384 bytes');
}
