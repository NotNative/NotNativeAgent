// SPDX-License-Identifier: Apache-2.0
export function questionViewportStart(session, available, room) {
  const selected = session.pendingQuestion.customMode
    ? available.length - 1 : available.findIndex((line) => line.startsWith('› '));
  return Math.min(session.pendingQuestion.scrollOffset
    ?? Math.max(0, selected - room + 2), Math.max(0, available.length - room));
}

export function visibleContentStart(options) {
  if (options.pendingPermission) return options.permissionStart;
  if (options.overlay) return options.overlayStart;
  if (options.help) return 0;
  return Math.max(0, options.viewportEnd - options.room);
}

export function tabState(session) {
  if (session.state === 'failed') return '!';
  if (session.pendingQuestion) return '?';
  if (session.state === 'needs_input' || session.state === 'awaiting_approval') return '?';
  if (session.activeTurnId) return '~';
  return '';
}
