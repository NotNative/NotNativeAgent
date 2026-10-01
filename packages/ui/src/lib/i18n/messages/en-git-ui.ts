// SPDX-License-Identifier: Apache-2.0
/** Git read dialogs (doc 06 §6.8): history and local/remote branch browsing. */
const enGitUi = {
  'gitUi.history.title': 'Commit history',
  'gitUi.history.logSize': 'Log size',
  'gitUi.history.loadMore': 'Load more',
  'gitUi.history.loadFailed': 'Failed to load log.',
  'gitUi.history.loading': 'Loading history...',
  'gitUi.history.copyCommitSha': 'Copy commit SHA {hash}',
  'gitUi.history.copied': 'Copied',
  'gitUi.history.copySha': 'Copy SHA',
  'gitUi.history.copyFailed': 'Could not copy SHA.',
  'gitUi.history.empty': 'No commits yet.',
  'gitUi.branches.title': 'Branches',
  'gitUi.branches.loadFailed': 'Failed to load branches.',
  'gitUi.branches.loading': 'Loading branches...',
  'gitUi.branches.searchLabel': 'Search branches',
  'gitUi.branches.searchPlaceholder': 'Search branches...',
  'gitUi.branches.local': 'Local',
  'gitUi.branches.remote': 'Remote',
  'gitUi.branches.empty': 'No branches.',
  'gitUi.branches.searchEmpty': 'No matching branches.',
  'gitUi.branches.noCurrent': 'Check out a local branch in Git before switching here.',
  'gitUi.branches.createNameLabel': 'New local branch name',
  'gitUi.branches.createNamePlaceholder': 'Create new branch...',
  'gitUi.branches.creating': 'Creating...',
  'gitUi.branches.createAndSwitch': 'Create & switch',
  'gitUi.branches.current': 'Current',
  'gitUi.branches.switchAria': 'Switch to {name}',
  'gitUi.branches.switching': 'Switching...',
  'gitUi.branches.switch': 'Switch',
  'gitUi.branches.switchFailed': 'Could not change branch',
  'gitUi.close': 'Close',
  'gitUi.closeNamed': 'Close: {name}'
};

export type PartialDictionary = typeof enGitUi;
export default enGitUi;
