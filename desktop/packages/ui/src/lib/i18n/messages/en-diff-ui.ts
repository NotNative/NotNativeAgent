// SPDX-License-Identifier: Apache-2.0
/** Closed English contract for DiffView controls, states, and hunk actions. */
const enDiffUi = {
  'diffUi.stageAll': 'Stage all changes',
  'diffUi.expandAll': 'Expand all',
  'diffUi.cleanTree': 'Working tree clean, no changes to display',
  'diffUi.parseFallback': 'Precise diff rows require a parsed patch; showing rendered summary instead.',
  'diffUi.scopeSelector': 'Select change scope',
  'diffUi.scopeAll': 'All: {count}',
  'diffUi.scopeWorking': 'Working: {count}',
  'diffUi.scopeStaged': 'Staged: {count}',
  'diffUi.largeDiff': 'Large diff ({count} changed lines) — rendering may be slow.',
  'diffUi.loading': 'Loading...',
  'diffUi.failedToLoad': 'Failed to load diff',
  'diffUi.hunkStageAria': 'Stage hunk {number}',
  'diffUi.hunkUnstageAria': 'Unstage hunk {number}',
  'diffUi.hunkDiscardAria': 'Discard hunk {number}',
  'diffUi.hunkStageLabel': 'stage',
  'diffUi.hunkUnstageLabel': 'unstage',
  'diffUi.hunkDiscardLabel': 'discard',
  'diffUi.hunkUnavailable': 'This hunk is no longer available. Refresh the diff band and try again.',
  'diffUi.hunkFailed': 'Failed to apply hunk action',
};

export type DiffUiDictionary = typeof enDiffUi;
export default enDiffUi;
