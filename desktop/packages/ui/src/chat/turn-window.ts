// SPDX-License-Identifier: Apache-2.0
/**
 * Turn-window virtualization (W-27.virtualization, doc 05 §J#3): the loaded
 * transcript can grow unbounded through history paging, so the DOM renders
 * only a newest-first window of turns; older loaded turns stay one click
 * away ("Show N older turns") and a `#message-<id>` deep link targeting a
 * hidden turn expands the window automatically — the anchor contract never
 * breaks. Cursor-based history paging (load-older) is orthogonal and stays.
 */

/** Newest turns always rendered without any expansion. */
export const TURN_WINDOW = 40;

export interface TurnLike {
  userMessage: { id: string };
  assistant?: { id: string }[];
}

/** Index of the first rendered turn for a window + operator expansion. */
export function windowStartIndex(turnCount: number, expandedTurns: number): number {
  if (turnCount <= TURN_WINDOW + expandedTurns) return 0;
  return turnCount - TURN_WINDOW - Math.max(0, expandedTurns);
}

/** Does this turn own the message id (prompt or any assistant reply)? */
export function turnHoldsMessage(turn: TurnLike, messageID: string): boolean {
  if (turn.userMessage.id === messageID) return true;
  return (turn.assistant ?? []).some((message) => message.id === messageID);
}

/** Hidden turn count for the current expansion. */
export function hiddenTurnCount(turnCount: number, expandedTurns: number): number {
  return Math.max(0, windowStartIndex(turnCount, expandedTurns));
}
