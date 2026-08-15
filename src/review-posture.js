// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';

const POSTURES = Object.freeze(['prompt', 'auto-review', 'unattended']);
const POSTURE_NOTICES = Object.freeze({
  prompt: 'Prompt: reviewed tool calls require an authenticated operator decision.',
  unattended: 'Unattended: review continues, but unresolved escalations are denied instead of prompting.',
  'auto-review': 'Auto-review: safe work is approved automatically; unresolved escalations prompt the operator.',
});

export function nextReviewPosture(current) {
  const index = requirePosture(current);
  return POSTURES[(index + 1) % POSTURES.length];
}

export function reviewPostureNotice(posture) {
  requirePosture(posture);
  return POSTURE_NOTICES[posture];
}

function requirePosture(posture) {
  const index = POSTURES.indexOf(posture);
  if (index < 0) throw new ContractError('review_posture_invalid', 'review posture is invalid');
  return index;
}
