// SPDX-License-Identifier: Apache-2.0
export type ReviewMode = 'default' | 'auto-review' | 'unattended';
export interface ReviewModeSnapshot {
  mode: ReviewMode;
  effective: 'auto-review' | 'unattended';
  revision: number;
  availableModes: ReviewMode[];
  defaultMode: 'auto-review';
}
const MODES: readonly unknown[] = ['default', 'auto-review', 'unattended'];
export function reviewModeSnapshot(value: unknown): ReviewModeSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const state = value as ReviewModeSnapshot;
  return MODES.includes(state.mode) && state.effective === (state.mode === 'unattended' ? 'unattended' : 'auto-review')
    && Number.isSafeInteger(state.revision) && state.revision >= 0 && state.defaultMode === 'auto-review'
    && Array.isArray(state.availableModes) && state.availableModes.length > 0 && state.availableModes.length <= 3
    && state.availableModes.every((mode) => MODES.includes(mode))
    && new Set(state.availableModes).size === state.availableModes.length && state.availableModes.includes(state.mode)
    ? state : null;
}
