// SPDX-License-Identifier: Apache-2.0
/**
 * Composer gates (doc 05 §B.5/§B.9/§F.4/§H.4): the exact keyboard policy,
 * send planning taxonomy (local commands / queue / steer / blocked-authority),
 * input-history recall with overlays, and send-failure classification.
 */
import { describe, expect, it } from 'vitest';
import { recallDirection, shouldSubmitEnter } from '../keyboard-policy.ts';
import { planSend, sendErrorKind } from '../send-planner.ts';
import { recallDirectionResult, recallList, recordSend, scopedKey } from '../input-history.ts';

const noBlockers = { blockedByPermission: false, blockedByQuestion: false };

describe('keyboard send policy', () => {
  it.each([
    // expanded, preference, mobile, shift, ctrl, meta, sends
    [true, null, false, false, false, false, false],
    [true, null, false, false, true, false, true],
    [false, null, false, false, false, false, true],
    [false, null, false, true, false, false, false],
    [false, null, true, false, false, false, false],
    [false, null, true, false, true, false, true],
    [false, true, true, false, false, false, true],
    [false, true, false, true, false, false, false],
    [false, false, false, false, false, false, false],
    [false, false, false, true, false, false, false],
    [false, false, false, false, true, false, true],
    [false, false, false, false, false, true, true],
  ] as const)('expanded=%s preference=%s mobile=%s shift=%s ctrl=%s meta=%s sends=%s', (isExpanded, enterToSend, isMobile, shiftKey, ctrlKey, metaKey, expected) => {
    expect(shouldSubmitEnter({ isExpanded, enterToSend, isMobile, shiftKey, ctrlKey, metaKey })).toBe(expected);
  });
});

describe('send planning (§B.9/§F.4)', () => {
  const tokens = [{ kind: 'skill' as const, name: 'skillx', start: 0, end: 7 }];

  it('runs an action local command without consuming anything else', () => {
    const plan = planSend({
      text: '/undo', queued: [], busy: false, memorySettings: 'queue',
      targets: { sessionID: 's1', directory: 'D:/w', model: { providerID: 'p', modelID: 'm' } },
      snippets: new Map(), tokens: [{ kind: 'command', name: 'undo', start: 0, end: 5 }], attachmentNames: [],
      ...noBlockers,
    });
    expect(plan.localCommand).toEqual({ name: 'undo', kind: 'action' });
    expect(plan.deliverable).toBeNull();
  });

  it('busy + queue semantics return a queue target and no deliverable', () => {
    const plan = planSend({
      text: 'follow-up', queued: [], busy: true, memorySettings: 'queue',
      targets: { sessionID: 's1', directory: 'D:/w', model: { providerID: 'p', modelID: 'm' } },
      snippets: new Map(), tokens: [], attachmentNames: ['a.txt'], ...noBlockers,
    });
    expect(plan.queueTarget).toMatchObject({ text: 'follow-up', mentions: [] });
    expect(plan.deliverable).toBeNull();
  });

  it('busy + steer returns the deliverable with delivery steer', () => {
    const plan = planSend({
      text: 'steer now', queued: [], busy: true, memorySettings: 'steer',
      targets: { sessionID: 's1', directory: 'D:/w', model: { providerID: 'p', modelID: 'm' } },
      snippets: new Map(), tokens: [], attachmentNames: [], ...noBlockers,
    });
    expect(plan.delivery).toBe('steer');
    expect(plan.deliverable?.text).toBe('steer now');
  });

  it('blocked-by-permission is AUTHORITATIVE: deny + queue, never deliver', () => {
    const plan = planSend({
      text: 'next step', queued: [], busy: true, memorySettings: 'queue',
      targets: { sessionID: 's1', directory: 'D:/w', model: { providerID: 'p', modelID: 'm' } },
      snippets: new Map(), tokens: [], attachmentNames: [],
      blockedByPermission: true, blockedByQuestion: false,
    });
    expect(plan.denyPermissions).toBe(true);
    expect(plan.queueTarget!.text).toBe('next step');
    expect(plan.deliverable).toBeNull();
    expect(plan.error).toBeNull();
  });

  it('skill tokens attach the synthetic instruction and snippets expand on send', () => {
    const plan = planSend({
      text: '/skillx now #snippet', queued: [], busy: false, memorySettings: 'queue',
      targets: { sessionID: 's1', directory: 'D:/w', model: { providerID: 'p', modelID: 'm' } },
      snippets: new Map([['snippet', 'EXPANDED']]), tokens: [...tokens, { kind: 'snippet', name: 'snippet', start: 12, end: 20 }], attachmentNames: [],
      ...noBlockers,
    });
    expect(plan.skillInstruction).toContain('/skillx.');
    expect(plan.deliverable?.text).toContain('EXPANDED');
  });
});

describe('error classification (§B.9 mapping)', () => {
  it('classifies 413, runtime switches, and transport failures', () => {
    expect(sendErrorKind({ status: 413 })).toBe('payload-too-large');
    expect(sendErrorKind(new Error('runtime changed'))).toBe('runtime-changed');
    expect(sendErrorKind(new Error('Failed to fetch'))).toBe('transport');
    expect(sendErrorKind({ status: 500 })).toBe('server');
    expect(sendErrorKind(new Error('mystery'))).toBe('unknown');
  });

  it('classifies NNA session_busy refusals as busy, distinct from other 409s', () => {
    // NNA's own refusal text rides either the message envelope or the raw message.
    expect(sendErrorKind({ status: 409, message: 'session_busy: NND session already has an active turn' })).toBe('busy');
    expect(sendErrorKind(new Error('promptAsync failed (409): NND session already has an active turn'))).toBe('busy');
    // A different 409 (duplicate id, upload conflict) must NOT read as busy.
    expect(sendErrorKind({ status: 409, message: 'request id already submitted' })).toBe('server');
    expect(sendErrorKind({ status: 409, message: 'attachment upload conflict' })).toBe('server');
  });

  it('prefers the structured NNA code over message prose for the busy kind', () => {
    // The client preserves NNA's error-envelope code; machine state wins
    // (CTL-DATA) even when the prose does not match the busy pattern.
    expect(sendErrorKind({ status: 409, code: 'session_busy', message: 'opaque refusal' })).toBe('busy');
    // A structured non-busy code never becomes busy, even if the prose
    // accidentally reads like a busy refusal.
    expect(sendErrorKind({ status: 409, code: 'duplicate_request', message: 'already has an active turn' })).toBe('server');
    // A code without a status classifies honestly rather than guessing.
    expect(sendErrorKind({ code: 'session_busy', message: 'no status carried' })).toBe('busy');
    expect(sendErrorKind({ code: 'other_code', message: 'no status carried' })).toBe('unknown');
  });
});

describe('input history (§H.4)', () => {
  it('records into the scoped bucket, dedupes, and merges visible prompts', () => {
    recordSend({ directory: 'D:/h', sessionID: 's9', text: 'one', attachments: [], scope: 'session', attachmentTarget: 'scoped' });
    recordSend({ directory: 'D:/h', sessionID: 's9', text: 'two', attachments: [], scope: 'session', attachmentTarget: 'scoped' });
    recordSend({ directory: 'D:/h', sessionID: 's9', text: 'one', attachments: [], scope: 'session', attachmentTarget: 'scoped' });
    const list = recallList({ directory: 'D:/h', sessionID: 's9', scope: 'session', visibleUserPrompts: ['three', 'two'] });
    expect(list.map((entry) => entry.text)).toEqual(['three', 'one', 'two']); // newest first; visible extras surface at top; dupes collapse
  });

  it('recall walks oldest-ward from the NEWEST entry and bails to the live draft', () => {
    const list = [{ text: 'b', attachments: [], at: 2 }, { text: 'a', attachments: [], at: 1 }]; // newest-first
    const first = recallDirectionResult(list, -1, 'older');
    expect(first.entry?.text).toBe('b'); // fresh ArrowUp recalls the most recent
    const deeper = recallDirectionResult(list, first.next, 'older');
    expect(deeper.entry?.text).toBe('a');
    expect(deeper.atStart).toBe(true); // oldest end
    const bail = recallDirectionResult(list, 0, 'newer');
    expect(bail.entry).toBeNull(); // ArrowDown past the live draft seam
    expect(recallDirection(0, 3, 'ArrowUp')).toBe('older');
    expect(recallDirection(3, 3, 'ArrowDown')).toBe('newer');
    expect(recallDirection(1, 3, 'ArrowDown')).toBeNull();
  });

  it('keys isolate runtime + directory + draft scope', () => {
    const a = scopedKey('D:/h', 's1');
    const b = scopedKey('D:/h', 's2');
    const draft = scopedKey('D:/h', null);
    expect(a).not.toBe(b);
    expect(a.endsWith('s1')).toBe(true);
    expect(draft.endsWith('draft')).toBe(true);
    expect(scopedKey('D:\\h', 's1')).toBe(a); // normalized directory keys
  });
});
