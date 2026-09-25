// SPDX-License-Identifier: Apache-2.0

export function describe(context) {
  return { id: context.sessionId, slug: context.sessionId, projectID: context.workspaceIds.values().next().value,
    directory: directoryFor(context), title: context.title, version: '1.0',
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...(context.contextUsage ? { metadata: { nnd: { context: context.contextUsage } } } : {}),
    time: { created: context.createdAt, updated: context.updatedAt,
      ...(context.archivedAt ? { archived: context.archivedAt } : {}) } };
}

export function nextUpdatedAt(context) { return Math.max(Date.now(), context.updatedAt + 1); }
export function sessionIdOrder(left, right) { return left.id < right.id ? -1 : left.id > right.id ? 1 : 0; }
export function titleOf(value) { return typeof value === 'string' && value.trim() && value.length <= 256 ? value.trim() : 'New session'; }
export function directoryOf(value) { return typeof value === 'string' && value.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(value) ? value : ''; }
export function directoryFor(context) { return directoryOf(context.engine.config?.workspaceRoot) || context.directory; }
