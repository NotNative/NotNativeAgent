// SPDX-License-Identifier: Apache-2.0
/** Agent group controls, status, confirmation, and failure notices. */
const enAgentGroups = {
  'agentGroups.title': "Agent Groups",
  'agentGroups.summary': "{runs} runs · {active} active",
  'agentGroups.deleteSessions': "Delete sessions",
  'agentGroups.deleteWorktrees': "Delete + worktrees",
  'agentGroups.close': "Close",
  'agentGroups.loading': "Loading groups…",
  'agentGroups.empty': "No worktree groups yet.",
  'agentGroups.groupRuns': "{count} runs",
  'agentGroups.select': "Select",
  'agentGroups.clear': "Clear",
  'agentGroups.untitled': "Untitled run",
  'agentGroups.active': "Run is active",
  'agentGroups.idle': "Run is idle",
  'agentGroups.openChat': "Open chat",
  'agentGroups.confirmSessions': "Delete {count} selected session(s)?",
  'agentGroups.confirmWorktrees': "Delete {count} selected session(s) and their worktrees?",
  'agentGroups.failureSummary': "Removed {removed} item(s); {failed} failed: {details}",
  'agentGroups.branchError': "Failed to delete local branch {branch}"
};

export type PartialDictionary = typeof enAgentGroups;
export default enAgentGroups;
