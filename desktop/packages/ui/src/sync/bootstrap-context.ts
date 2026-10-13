// SPDX-License-Identifier: Apache-2.0
/** Shared directory-bootstrap context + outcome contract (doc 04 §C.3). */
import type { StoreApi } from 'zustand/vanilla';
import type { Session } from '../lib/nnd/types.ts';
import type { DirectoryStore } from './types.ts';

export interface DirectoryBootstrapContext {
  activeProjectFor: (directory: string) => string | null;
  mergeBootstrap: (dir: string, store: StoreApi<DirectoryStore>, rootSessions: Session[], allSessions: Session[] | null, baselineRevision: number) => void;
}

export type DirectoryBootstrapOutcome = 'complete' | 'failed';
