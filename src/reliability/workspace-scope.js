// SPDX-License-Identifier: Apache-2.0

export function workspaceTransitionClassification(outsideWorkspace) {
  return Object.freeze({
    risk: 'review_required',
    reason: outsideWorkspace ? 'working_directory_host_transition' : 'working_directory_transition',
    effect: 'reversible',
    scope: outsideWorkspace ? 'host' : 'conversation_workspace',
    complexity: 'simple',
  });
}
