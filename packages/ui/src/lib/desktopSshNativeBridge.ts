// SPDX-License-Identifier: Apache-2.0
import type { DesktopSshBridge } from './desktopSshStore.ts';
import type { DesktopSshInstanceStatus } from './desktopSsh.ts';

/** Adapt the narrow Electron invoke/event globals to the SSH store contract. */
export function createDesktopSshNativeBridge(windowRef: Pick<Window,
  '__NOTNATIVE_DESKTOP_INVOKE__' | '__NOTNATIVE_DESKTOP_EVENTS__'> = window): DesktopSshBridge | null {
  const invokeNative = windowRef.__NOTNATIVE_DESKTOP_INVOKE__;
  if (typeof invokeNative !== 'function') return null;
  return {
    async invoke(command, payload) {
      const reply = await invokeNative(command, payload);
      if (!reply.ok) throw new Error(reply.error || 'desktop-ssh-operation-failed');
      return reply.result;
    },
    listenStatus(handler) {
      return windowRef.__NOTNATIVE_DESKTOP_EVENTS__?.onSshStatus?.((detail) => {
        handler(detail as DesktopSshInstanceStatus);
      }) ?? (() => {});
    },
    async readSshConfig() {
      const reply = await invokeNative('desktopSshReadConfig');
      if (!reply.ok) throw new Error(reply.error || 'desktop-ssh-config-read-failed');
      if (typeof reply.result !== 'string') throw new Error('desktop-ssh-config-invalid');
      return reply.result;
    },
  };
}
