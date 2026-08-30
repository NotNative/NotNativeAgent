// SPDX-License-Identifier: Apache-2.0
import { toolContinuationHint } from '../tools/loop.js';
import { blockToolRequests } from './runtime-helpers.js';

export async function continueAfterExactToolBoundary(engine, active, items, progress, recordRecovery) {
  const requestFingerprints = engine.reliability.toolRequestFingerprints(items);
  const revision = blockToolRequests(active, requestFingerprints);
  const boundary = engine.reliability.behavioralCheckpoint(
    active, 'tool_no_progress', 'block_exact_request', progress.count,
    { observable_state_revision: revision, request_fingerprints: requestFingerprints },
  );
  await recordRecovery(boundary);
  engine.state.transition('preparing_continuation', {
    trigger: 'exact_tool_request_blocked', turnId: active.turnId,
  });
  return {
    continue: true,
    hint: toolContinuationHint(items, engine.reliability.hint(boundary)),
    forceCompact: false,
  };
}
