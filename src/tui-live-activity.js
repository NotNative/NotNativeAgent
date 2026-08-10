// SPDX-License-Identifier: Apache-2.0
import { synthwaveActivityIndicator } from './tui-colors.js';

const UNICODE_SPINNER = Object.freeze(['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']);
const ASCII_SPINNER = Object.freeze(['|', '/', '-', '\\']);

export function liveActivityLine(session, capabilities) {
  if (!session.activeTurnId || ['idle', 'needs_input', 'failed'].includes(session.state)) return null;
  const frames = capabilities.unicode === false ? ASCII_SPINNER : UNICODE_SPINNER;
  const frame = capabilities.reducedMotion ? 0 : (capabilities.animationFrame ?? 0);
  const marker = capabilities.reducedMotion ? (capabilities.unicode === false ? '*' : '•') : frames[frame % frames.length];
  return `  ${marker} ${liveActivityLabel(session.state)}`;
}

export function decorateLiveActivity(line, animationFrame) {
  const activity = line.match(/^  ([⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏•|/\\*-]) (.+)$/u);
  return activity ? synthwaveActivityIndicator(activity[1], activity[2], animationFrame) : null;
}

function liveActivityLabel(state) {
  if (state === 'preparing') return 'Preparing…';
  if (state === 'waiting_provider') return 'Waiting for model…';
  if (state === 'streaming') return 'Responding…';
  if (state === 'awaiting_approval') return 'Reviewing tool use…';
  if (state === 'running_tool') return 'Running tool…';
  if (state === 'recovering') return 'Recovering…';
  if (state === 'cancelling') return 'Cancelling…';
  return 'Working…';
}
