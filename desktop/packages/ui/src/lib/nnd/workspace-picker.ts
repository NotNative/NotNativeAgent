// SPDX-License-Identifier: Apache-2.0
/** Directory picking for the workspace model (gap b). Prefers the Electron
 *  native chooser (desktop_pick_directory) when the desktop bridge exists;
 *  falls back to a typed path in the browser door, where no bridge exists.
 *  Returns an absolute path or null when the operator cancelled. */
type DesktopInvoke = ((command: string, payload?: unknown) => Promise<{ ok?: boolean; result?: unknown; error?: string }>) | undefined;

function desktopInvoke(): DesktopInvoke {
  return (window as { __NOTNATIVE_DESKTOP_INVOKE__?: DesktopInvoke }).__NOTNATIVE_DESKTOP_INVOKE__;
}

export async function pickWorkspaceDirectory(): Promise<string | null> {
  const invoke = desktopInvoke();
  if (invoke) {
    try {
      const reply = await invoke('desktop_pick_directory');
      if (reply?.ok && typeof reply.result === 'string' && reply.result.trim()) return reply.result;
      if (reply?.ok) return null; // operator cancelled the native dialog
      // Bridge answered but refused: fall through to the typed path so the
      // browser door and older shells keep a working flow.
    } catch { /* bridge absent or frame gone: typed fallback */ }
  }
  const typed = window.prompt('Absolute folder path to add as a workspace:');
  return typed && typed.trim() ? typed.trim() : null;
}
