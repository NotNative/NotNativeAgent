// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { liveActivityLine } from '../src/tui/live-activity.js';

test('provider wait names the next step once earlier steps are committed', () => {
  const session = {
    activeTurnId: 'turn-1', state: 'waiting_provider', turnStartedAt: Date.now() - 70_000,
    records: [
      { type: 'message', role: 'assistant', turn_id: 'turn-1', stepId: 'step-1', content: 'read the config' },
      { type: 'tool_status', turn_id: 'turn-1', tool_request_id: 't1', tool: 'fs_read_text', status: 'succeeded' },
      { type: 'message', role: 'assistant', turn_id: 'turn-1', stepId: 'step-2', content: 'probing ports' },
    ],
  };
  const line = liveActivityLine(session, { unicode: false, reducedMotion: true, now: Date.now() });
  assert.match(line, /Waiting for model · step 3… · 1m \d\ds/u);
});

test('provider wait claims no step count without committed step evidence', () => {
  const session = {
    activeTurnId: 'turn-1', state: 'waiting_provider', turnStartedAt: Date.now() - 5_000,
    records: [
      { type: 'message', role: 'assistant', turn_id: 'turn-1', content: 'text without a step id' },
      { type: 'message', role: 'assistant', turn_id: 'other-turn', stepId: 'step-9', content: 'other turn' },
    ],
  };
  assert.match(liveActivityLine(session, { unicode: false, reducedMotion: true }), /Waiting for model…/u);
});
