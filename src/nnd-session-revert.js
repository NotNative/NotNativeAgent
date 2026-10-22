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

function hideRevertedTurns(engine, turns) {
  const firstHidden = engine.transcript.findIndex((item) => turns.has(turnIdOf(item)));
  for (let i = engine.transcript.length - 1; i >= 0; i -= 1) {
    const item = engine.transcript[i];
    // Compaction facts summarize earlier records but carry no turn identity.
    if (turns.has(turnIdOf(item)) || i > firstHidden && firstHidden >= 0 && item?.type === 'compaction') {
      engine.transcript.splice(i, 1);
    }
  }
}

function restoreRevertedTurns(engine, records) {
  // Invariant: transcript and terminal carry follow the same effective revert timeline.
  const replayed = restoreSessionRecords(records, {});
  engine.transcript.splice(0, engine.transcript.length,
    ...replayed.transcript.filter((item) => item.type !== 'turn_outcome'));
  engine.latestTurnOutcome = replayed.latestTurnOutcome;
}

export async function runNndSessionRevert(context, body) {
  if (context.liveTurn || context.engine.active && !context.engine.active.finalized) {
    throw new ContractError('nnd_revert_busy', 'NND session is busy');
  }
  const { turnId, messageId } = resolveForkBoundary(context.engine.transcript, context.sessionId, body?.messageID);
  const { records } = await context.engine.store.readRecords();
  const revertedTurns = collectRevertedTurns(records, turnId);
  const payload = { turn_id: turnId, boundary_message_id: messageId,
    ...(typeof body?.partID === 'string' && body.partID.length > 0 && body.partID.length <= 256
      ? { part_id: body.partID } : {}),
    reverted_turn_ids: revertedTurns };
  await context.engine.store.append('revert_point', payload);
  hideRevertedTurns(context.engine, new Set(revertedTurns));
  context.engine.latestTurnOutcome = restoreSessionRecords([
    ...records, { type: 'revert_point', payload },
  ]).latestTurnOutcome;
  return { reverted_turn_ids: revertedTurns, boundary_message_id: messageId };
}

export async function runNndSessionUnrevert(context) {
  if (context.liveTurn || context.engine.active && !context.engine.active.finalized) {
    throw new ContractError('nnd_revert_busy', 'NND session is busy');
  }
  const { records } = await context.engine.store.readRecords();
  // A cleared marker closes the most recent open revert cycle (matching the
  // replay pre-scan's stack), so unrevert is valid while any cycle is open.
  const open = [];
  for (const record of records) {
    if (record?.type === 'revert_point') open.push(record);
    else if (record?.type === 'revert_cleared') open.pop();
  }
  const point = open.at(-1);
  if (!point) throw new ContractError('nnd_revert_none', 'NND session has no revert point to restore');
  await context.engine.store.append('revert_cleared', {});
  // Resync against the journal that already contains the cleared marker.
  restoreRevertedTurns(context.engine, (await context.engine.store.readRecords()).records);
  return { restored_turn_ids: point.payload.reverted_turn_ids };
}
