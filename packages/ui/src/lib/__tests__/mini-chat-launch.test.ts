// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { readMiniChatLaunch } from '../miniChatLaunch.ts';

describe('readMiniChatLaunch', () => {
  it('accepts bounded session and draft launch context', () => {
    expect(readMiniChatLaunch('?miniChat=1&mode=session&sessionId=s_1&directory=C%3A%2Fwork&projectId=p1'))
      .toEqual({ enabled: true, mode: 'session', sessionId: 's_1', directory: 'C:/work', projectId: 'p1' });
    expect(readMiniChatLaunch('?miniChat=1&mode=draft&directory=%2Fwork'))
      .toEqual({ enabled: true, mode: 'draft', sessionId: null, directory: '/work', projectId: null });
  });

  it('fails malformed session identifiers and control-bearing paths closed to a draft', () => {
    expect(readMiniChatLaunch('?miniChat=1&mode=session&sessionId=%00bad&directory=%00'))
      .toEqual({ enabled: true, mode: 'draft', sessionId: null, directory: '', projectId: null });
    expect(readMiniChatLaunch('?mode=session&sessionId=s1').enabled).toBe(false);
  });
});
