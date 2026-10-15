// SPDX-License-Identifier: Apache-2.0
/** Directory picking for the workspace model. The Electron bridge owns the
 * native chooser; a browser cannot expose an absolute directory path. */
type DesktopInvoke = ((command: string, payload?: unknown) => Promise<{ ok?: boolean; result?: unknown; error?: string }>) | undefined;

function desktopInvoke(): DesktopInvoke {
  return (window as { __NOTNATIVE_DESKTOP_INVOKE__?: DesktopInvoke }).__NOTNATIVE_DESKTOP_INVOKE__;
}

export function hasNativeWorkspacePicker(): boolean {
  return typeof desktopInvoke() === 'function';
}

export async function pickWorkspaceDirectory(): Promise<string | null> {
  const invoke = desktopInvoke();
  if (!invoke) throw new Error('Open the desktop app to choose a workspace folder.');
  const reply = await invoke('desktop_pick_directory');
  if (!reply?.ok) throw new Error(`Could not open the folder picker: ${reply?.error ?? 'desktop bridge unavailable'}`);
  if (reply.result === null) return null;
  if (typeof reply.result === 'string' && reply.result.trim()) return reply.result;
  throw new Error('The folder picker returned an invalid path.');
}
