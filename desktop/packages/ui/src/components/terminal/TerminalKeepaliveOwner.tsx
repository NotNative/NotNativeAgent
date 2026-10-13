// SPDX-License-Identifier: Apache-2.0
/** One app-lifetime keepalive for live PTYs in every visited directory.
 * TerminalView owns the visible observer/stream, not the idle-reaper lease. */
import { useEffect } from 'react';
import { startKeepaliveTouch } from '../../lib/terminal/observer.ts';
import { useTerminalStore } from '../../lib/terminal/store.ts';

export function TerminalKeepaliveOwner(): null {
  useEffect(() => startKeepaliveTouch(() => {
    const ids = new Set<string>();
    for (const directory of Object.values(useTerminalStore.getState().dirs)) {
      for (const tab of directory.tabs) {
        if (tab.lifecycle !== 'exited' && tab.terminalSessionId) ids.add(tab.terminalSessionId);
      }
    }
    return [...ids];
  }), []);
  return null;
}
