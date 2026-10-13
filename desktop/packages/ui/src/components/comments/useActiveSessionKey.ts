// SPDX-License-Identifier: Apache-2.0
/** Active inline-comment target (doc 06 §10.1): the session key is the
 * active session id, or 'draft' while a new-session draft is open. */
import { useSessionViewStore } from '../../sync/view-store.ts';

export function useActiveSessionKey(): string | null {
  return useSessionViewStore((state) => state.currentSessionId ?? 'draft');
}
