// SPDX-License-Identifier: Apache-2.0
const POSTURES = Object.freeze(['prompt', 'auto-review', 'unattended']);

export function nextReviewPosture(current) {
  return POSTURES[(POSTURES.indexOf(current) + 1) % POSTURES.length];
}

export function reviewPostureNotice(posture) {
  if (posture === 'prompt') return 'Prompt: reviewed tool calls require an authenticated operator decision.';
  if (posture === 'unattended') return 'Unattended: review continues, but unresolved escalations are denied instead of prompting.';
  return 'Auto-review: safe work is approved automatically; unresolved escalations prompt the operator.';
}
