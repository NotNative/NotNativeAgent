// SPDX-License-Identifier: Apache-2.0

export const DESTRUCTIVE_KEY_WINDOW_MS = 1_000;

export class DestructiveKeyGuard {
  #armed = null;
  #timer = null;

  constructor(options = {}) {
    this.windowMs = options.windowMs ?? DESTRUCTIVE_KEY_WINDOW_MS;
    this.now = options.now ?? (() => Date.now());
  }

  confirm(intent, onExpire = null) {
    const timestamp = this.now();
    if (this.#armed?.intent === intent && timestamp <= this.#armed.expiresAt) {
      this.reset();
      return true;
    }
    this.reset();
    const armed = { intent, expiresAt: timestamp + this.windowMs };
    this.#armed = armed;
    if (onExpire) {
      this.#timer = setTimeout(() => {
        if (this.#armed !== armed) return;
        this.#armed = null;
        this.#timer = null;
        onExpire();
      }, this.windowMs);
      this.#timer.unref?.();
    }
    return false;
  }

  reset() {
    this.#armed = null;
    clearTimeout(this.#timer);
    this.#timer = null;
  }
}

export async function handleDestructiveEscape(workspace, guard) {
  const session = workspace.projection.active();
  if (session.editor.text.length > 0) {
    if (confirmOrWarn(workspace, guard, 'escape:clear_editor', 'Press Esc again within 1 second to clear the input.')) session.editor.take();
    return;
  }
  if (session.pendingPermission || session.activeTurnId) {
    if (confirmOrWarn(workspace, guard, 'escape:cancel_turn', 'Press Esc again within 1 second to cancel the active turn.')) await workspace.cancelActive();
  } else guard.reset();
}

export async function handleDestructiveCancel(workspace, stop, guard) {
  const session = workspace.projection.active();
  if (!session.pendingPermission && !session.activeTurnId) {
    if (confirmOrWarn(workspace, guard, 'control-c:exit', 'Press Ctrl+C again within 1 second to exit NNA.')) await stop();
    return;
  }
  if (confirmOrWarn(workspace, guard, 'control-c:cancel_turn', 'Press Ctrl+C again within 1 second to cancel the active turn.')) await workspace.cancelActive();
}

function confirmOrWarn(workspace, guard, intent, text) {
  const confirmed = guard.confirm(intent, () => {
    if (workspace.projection.notice?.kind !== 'confirmation' || workspace.projection.notice.text !== text) return;
    workspace.projection.clearNotice();
    workspace.onChange();
  });
  if (!confirmed) workspace.projection.showNotice('confirmation', text);
  return confirmed;
}
