// SPDX-License-Identifier: Apache-2.0
/** Shell-level toasts, status, mini chat controls, and navigation labels. */
const enShellUi = {
  'shell.toast.nothingSelected': 'Nothing selected to use {command}.',
  'shell.toast.nothingToRevert': 'Nothing to revert yet.',
  'shell.toast.revertFailed': 'Failed to revert the conversation.',
  'shell.toast.redoFailed': 'Failed to redo the reverted slice.',
  'shell.toast.compactHarness': 'Compaction runs harness-side.',
  'shell.toast.titleEmpty': 'Title unchanged — empty name.',
  'shell.toast.renamed': 'Session renamed.',
  'shell.toast.renameFailed': 'Failed to rename the session.',
  'shell.minichat.pin': 'Pin',
  'shell.minichat.pinAria': 'Pin Mini Chat',
  'shell.minichat.close': 'Close',
  'shell.minichat.closeAria': 'Close Mini Chat',
  'shell.minichat.open': 'Open',
  'shell.minichat.openAria': 'Open Mini Chat',
  'shell.status.connected': 'Connected',
  'shell.status.reconnecting': 'Reconnecting',
  'shell.nav.changes': 'Changes',
  'shell.nav.git': 'Git',
  'shell.nav.plan': 'Plan',
  'shell.nav.scheduledTasks': 'Scheduled tasks',
  'shell.nav.agentGroups': 'Agent groups',
  'shell.nav.worktrees': 'Worktrees',
  'shell.nav.multiRun': 'Multi-run',
  'shell.nav.files': 'Files',
  'shell.nav.settingsShortcut': 'Settings (Ctrl+Comma)',
  'shell.nav.settings': 'Settings',
};

export type PartialDictionary = typeof enShellUi;
export default enShellUi;

