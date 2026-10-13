// SPDX-License-Identifier: Apache-2.0
/**
 * Submission keyboard policy (doc 05 §B.5) — the exact algorithm.
 * `preserveDeferredEnterShift` guards CodeMirror's mobile deferred Enter
 * modifier loss; kept for the editor swap later.
 */
export interface KeyboardPolicyInput {
  isExpanded: boolean;
  enterToSend: boolean | null; // null = user never configured
  isMobile: boolean;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

export function shouldSubmitEnter(input: KeyboardPolicyInput): boolean {
  const isCtrlEnter = input.ctrlKey || input.metaKey;
  if (input.isExpanded) return isCtrlEnter;
  if (input.enterToSend === null) {
    return !input.shiftKey && !input.isMobile ? true : isCtrlEnter;
  }
  // configured: send = (enterToSend ? !shift : shift); Ctrl/Cmd always sends
  const sends = input.enterToSend ? !input.shiftKey : input.shiftKey;
  return isCtrlEnter || sends;
}

export function preserveDeferredEnterShift(input: Pick<KeyboardPolicyInput, 'enterToSend' | 'isMobile'>): boolean {
  return input.enterToSend === null || !input.isMobile;
}

/** Input-history recall policy (§H.4): ArrowUp from start, ArrowDown from end. */
export function recallDirection(caret: number, length: number, key: string): 'older' | 'newer' | null {
  if (key === 'ArrowUp' && caret === 0) return 'older';
  if (key === 'ArrowDown' && caret === length) return 'newer';
  return null;
}
