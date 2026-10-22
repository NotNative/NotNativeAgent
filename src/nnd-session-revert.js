// SPDX-License-Identifier: Apache-2.0
/** Native timeline revert (W-23): a non-destructive revert point.
 *
 *  The journal keeps every record; a `revert_point` names the reverted turns,
 *  replay cuts them from transcript/turn state until a `revert_cleared`
 *  record, and unrevert appends that marker and replays the hidden turns'
 *  transcript payloads back into the live engine. New turns after a revert
 *  carry fresh turn ids, so they replay normally without unrevert. */
import { ContractError } from './ids.js';
import { resolveForkBoundary } from './persistence/fork-records.js';
import { restoreSessionRecords } from './persistence/session-history.js';
import { beginNndTimelineMutation, endNndTimelineMutation } from './nnd-timeline-mutation.js';
export { settleNndTimelinesForShutdown } from './nnd-timeline-mutation.js';

const LIVE_RECORD_TYPES = new Set(['message', 'tool_request', 'tool_result', 'compaction', 'attachment_fact']);

function turnIdOf(payload) {
  const turnId = payload?.turnId ?? payload?.turn_id;
  return typeof turnId === 'string' && turnId.length > 0 ? turnId : null;
}

function collectRevertedTurns(records, boundaryTurnId) {
  let started = false;
  const turns = new Set([boundaryTurnId]);
  for (const record of records) {
    if (!started && turnIdOf(record?.payload) === boundaryTurnId
      && (record.type === 'turn_accepted' || LIVE_RECORD_TYPES.has(record.type))) started = true;
    if (!started) continue;
    const turnId = turnIdOf(record?.payload);
    if (turnId) turns.add(turnId);
  }
  return [...turns];
}

function projectedTranscript(records, marker) {
  const replayed = restoreSessionRecords([...records, marker]);
  return { transcript: replayed.transcript.filter((item) => item.type !== 'turn_outcome'),
    latestTurnOutcome: replayed.latestTurnOutcome };
}

function applyTimeline(engine, projection) {
  // Invariant: replay can exceed the JavaScript argument limit; replace the
  // array only after the complete projection has been built.
  engine.transcript = projection.transcript;
  engine.latestTurnOutcome = projection.latestTurnOutcome;
}

async function appendTimelineMarker(context, store, type, payload) {
  try { await store.append(type, payload); }
  catch (error) {
    // Security: a failed flush can still have written the marker. Keep this
    // live context unavailable until journal recovery establishes its tip.
    context.closing = true;
    throw error;
  }
}

export async function runNndSessionRevert(context, body) {
  const store = beginNndTimelineMutation(context, 'revert');
  try {
    const { turnId, messageId } = resolveForkBoundary(context.engine.transcript, context.sessionId, body?.messageID);
    const { records } = await store.readRecords();
    const revertedTurns = collectRevertedTurns(records, turnId);
    const payload = { turn_id: turnId, boundary_message_id: messageId,
      ...(typeof body?.partID === 'string' && body.partID.length > 0 && body.partID.length <= 256
        ? { part_id: body.partID } : {}),
      reverted_turn_ids: revertedTurns };
    const projection = projectedTranscript(records, { type: 'revert_point', payload });
    await appendTimelineMarker(context, store, 'revert_point', payload);
    applyTimeline(context.engine, projection);
    return { reverted_turn_ids: revertedTurns, boundary_message_id: messageId };
  } finally { endNndTimelineMutation(context); }
}

export async function runNndSessionUnrevert(context) {
  const store = beginNndTimelineMutation(context, 'revert');
  try {
    const { records } = await store.readRecords();
    // A cleared marker closes the most recent open revert cycle.
    const open = [];
    for (const record of records) {
      if (record?.type === 'revert_point') open.push(record);
      else if (record?.type === 'revert_cleared') open.pop();
    }
    const point = open.at(-1);
    if (!point) throw new ContractError('nnd_revert_none', 'NND session has no revert point to restore');
    const projection = projectedTranscript(records, { type: 'revert_cleared', payload: {} });
    await appendTimelineMarker(context, store, 'revert_cleared', {});
    applyTimeline(context.engine, projection);
    return { restored_turn_ids: point.payload.reverted_turn_ids };
  } finally { endNndTimelineMutation(context); }
}
