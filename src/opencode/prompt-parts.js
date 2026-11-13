// SPDX-License-Identifier: Apache-2.0
// Turning a client's prompt parts into the one string a turn is admitted with.
//
// Why this is its own module: the rules are all about refusing input — empty
// prompts, non-text parts, too many parts, text past the allowance — and they
// read better as one block than as the tail of the session state machine that
// calls them.
import { ContractError } from '../ids.js';

/** The prompt text one admission carries, or a refusal naming what was wrong.
 *
 *  Why the caller supplies the bounds: the surface's own part count and text
 *  allowance are policy (`wire-session.js`), not a property of the join. Taking
 *  them as arguments keeps this module from holding a second, drifting copy of
 *  numbers that decide what a client may send.
 *
 *  Why join with a newline: OpenCode admits a list of parts and a client may send
 *  several to mean one utterance; joining them keeps the whole prompt one
 *  operator message rather than dropping all but the first.
 *
 *  Why the byte bound as well as the per-part one: the per-part check cannot see
 *  a caller that sends many parts each just under the limit, which is exactly the
 *  shape an automated client produces. */
export function buildPromptCommand(parts, limits = {}) {
  const maxParts = limits.maxParts;
  const maxText = limits.maxText;
  // Why the same code as a bad part: both mean "this prompt cannot be admitted
  // as given", and the registry keeps the wire's refusal vocabulary small on
  // purpose. A missing bound is a caller bug, not a new operator-facing state.
  if (!Number.isSafeInteger(maxParts) || !Number.isSafeInteger(maxText)) {
    throw new ContractError('opencode_prompt_parts_invalid', 'prompt bounds must be supplied as integers');
  }
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new ContractError('opencode_prompt_parts_invalid', 'prompt requires at least one text part');
  }
  if (parts.length > maxParts) throw new ContractError('opencode_prompt_parts_invalid', 'prompt exceeds part bounds');
  const texts = [];
  let totalBytes = 0;
  for (const part of parts) {
    const text = requireTextPart(part, maxText);
    totalBytes += Buffer.byteLength(text, 'utf8') + Number(texts.length > 0);
    if (totalBytes > maxText) throw new ContractError('opencode_prompt_parts_invalid', 'combined prompt text exceeds bounds');
    texts.push(text);
  }
  return texts.join('\n');
}

function requireTextPart(part, maxText) {
  if (!part || typeof part !== 'object' || part.type !== 'text') {
    throw new ContractError('opencode_prompt_parts_unsupported', 'only text prompt parts are accepted');
  }
  if (typeof part.text !== 'string' || part.text.length === 0) {
    throw new ContractError('opencode_prompt_parts_invalid', 'text prompt parts require text');
  }
  if (part.text.length > maxText) throw new ContractError('opencode_prompt_parts_invalid', 'prompt text exceeds bounds');
  return part.text;
}
