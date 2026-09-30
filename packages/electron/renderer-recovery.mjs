// SPDX-License-Identifier: Apache-2.0
/** Bounded Electron renderer recovery (doc 09 §12.1). */

const RECOVERABLE_REASONS = new Set(['abnormal-exit', 'crashed', 'oom', 'memory-eviction']);
const RECOVERY_WINDOW_MS = 60_000;
const MAX_RELOADS = 3;
const RELOAD_DELAY_MS = 100;

export function attachRendererRecovery(win, options = {}) {
  const contents = win?.webContents;
  if (!contents || contents.isDestroyed()) return () => {};

  const label = options.label ?? 'window';
  const log = options.log ?? console.error;
  const now = options.now ?? Date.now;
  let reloads = [];
  let timer = null;
  let disposed = false;

  const onGone = (_event, details = {}) => {
    const reason = typeof details.reason === 'string' ? details.reason : 'unknown';
    if (!RECOVERABLE_REASONS.has(reason)) {
      log(`[shell] ${label} renderer exited without recovery: ${reason} (${details.exitCode ?? 'unknown'})`);
      return;
    }
    if (timer !== null || disposed || contents.isDestroyed()) return;

    const current = now();
    reloads = reloads.filter((at) => current - at < RECOVERY_WINDOW_MS);
    if (reloads.length >= MAX_RELOADS) {
      log(`[shell] ${label} renderer recovery budget exhausted: ${reason}`);
      return;
    }

    timer = setTimeout(() => {
      timer = null;
      if (disposed || win.isDestroyed() || contents.isDestroyed()) return;
      const attemptedAt = now();
      reloads = reloads.filter((at) => attemptedAt - at < RECOVERY_WINDOW_MS);
      if (reloads.length >= MAX_RELOADS) {
        log(`[shell] ${label} renderer recovery budget exhausted: ${reason}`);
        return;
      }
      reloads.push(attemptedAt);
      log(`[shell] recovering ${label} renderer (${reason}, attempt ${reloads.length}/${MAX_RELOADS})`);
      try { contents.reload(); }
      catch (error) { log(`[shell] ${label} renderer reload failed: ${String(error)}`); }
    }, RELOAD_DELAY_MS);
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (timer !== null) { clearTimeout(timer); timer = null; }
    contents.removeListener('render-process-gone', onGone);
    win.removeListener('closed', dispose);
  };

  contents.on('render-process-gone', onGone);
  win.once('closed', dispose);
  return dispose;
}
