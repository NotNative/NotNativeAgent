// SPDX-License-Identifier: Apache-2.0
/** Session-memory commit drafts; never sync or persist text across app restarts. */
import { create } from 'zustand';

const MAX_DRAFTS = 20;

export function commitDraftScope(runtimeKey: string, directory: string): string {
  let normalized = directory.trim().replaceAll('\\', '/');
  normalized = normalized.replace(/^([a-z]):/u, (_match, drive: string) => `${drive.toUpperCase()}:`);
  normalized = normalized.length > 1 ? normalized.replace(/\/+$/u, '') : normalized;
  return `${runtimeKey}\u0000${normalized}`;
}

interface DraftState {
  drafts: Record<string, string>;
  setDraft: (key: string, text: string) => void;
  clearIfMatches: (key: string, submittedText: string) => void;
}

export const useCommitDraftStore = create<DraftState>((set) => ({
  drafts: {},
  setDraft: (key, text) => set((state) => {
    const drafts = { ...state.drafts };
    delete drafts[key];
    if (text.length > 0) drafts[key] = text;
    while (Object.keys(drafts).length > MAX_DRAFTS) delete drafts[Object.keys(drafts)[0]!];
    return { drafts };
  }),
  clearIfMatches: (key, submittedText) => set((state) => {
    if (state.drafts[key] !== submittedText) return state;
    const drafts = { ...state.drafts };
    delete drafts[key];
    return { drafts };
  }),
}));
