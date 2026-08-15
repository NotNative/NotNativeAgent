// SPDX-License-Identifier: Apache-2.0

export function registerFatalTuiCleanup(boundary, terminal, workspace, logger) {
  return boundary?.registerCleanup(() => {
    terminal.restore();
    return Promise.allSettled([workspace.shutdown(), logger.flush?.()]);
  }) ?? (() => undefined);
}
