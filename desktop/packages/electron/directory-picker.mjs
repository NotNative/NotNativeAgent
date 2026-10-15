// SPDX-License-Identifier: Apache-2.0
/** A human-paced dialog belongs to its window, not to an IPC deadline. */
export function createDirectoryPicker(dialog) {
  const pending = new WeakMap();
  return function pickDirectory(window, contents) {
    const owner = window ?? contents;
    if (owner.isDestroyed?.()) return Promise.resolve({ ok: true, result: null });
    const existing = pending.get(owner);
    if (existing) return existing.invalidated
      ? Promise.resolve({ ok: false, error: 'directory-picker-already-open' }) : existing.promise;
    let finish;
    const state = { invalidated: false, promise: new Promise(resolve => { finish = resolve; }) };
    pending.set(owner, state);
    const cleanup = () => {
      window?.removeListener?.('closed', cancel);
      contents.removeListener?.('destroyed', cancel);
      contents.removeListener?.('render-process-gone', cancel);
      contents.removeListener?.('did-start-navigation', navigation);
    };
    const cancel = () => { state.invalidated = true; cleanup(); finish({ ok: true, result: null }); };
    const navigation = (_event, _url, inPlace, mainFrame) => { if (!inPlace && mainFrame !== false) cancel(); };
    window?.once?.('closed', cancel);
    contents.once?.('destroyed', cancel);
    contents.once?.('render-process-gone', cancel);
    contents.on?.('did-start-navigation', navigation);
    const options = { properties: ['openDirectory', 'createDirectory'], title: 'Choose a workspace folder' };
    void Promise.resolve().then(() => window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options))
      .then(result => {
        if (state.invalidated) return;
        const path = !result.canceled && Array.isArray(result.filePaths) ? result.filePaths[0] : null;
        cleanup(); pending.delete(owner);
        finish({ ok: true, result: typeof path === 'string' && path ? path : null });
      }, error => { if (!state.invalidated) { cleanup(); pending.delete(owner); finish({ ok: false, error: error instanceof Error ? error.message : String(error) }); } })
      .finally(() => { cleanup(); if (pending.get(owner) === state) pending.delete(owner); });
    return state.promise;
  };
}
