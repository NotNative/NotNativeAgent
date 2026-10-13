// SPDX-License-Identifier: Apache-2.0

export interface MiniChatLaunch {
  enabled: boolean;
  mode: 'session' | 'draft';
  sessionId: string | null;
  directory: string;
  projectId: string | null;
}

/** Read bounded, non-secret launch context from a native Mini Chat URL. */
export function readMiniChatLaunch(search: string): MiniChatLaunch {
  const params = new URLSearchParams(search);
  const enabled = params.get('miniChat') === '1';
  const rawMode = params.get('mode');
  const rawSession = params.get('sessionId');
  const rawDirectory = params.get('directory') ?? '';
  const rawProject = params.get('projectId');
  const sessionId = rawSession !== null && rawSession.length > 0 && rawSession.length <= 256
    && !/[\u0000-\u001f\u007f]/u.test(rawSession) ? rawSession : null;
  const directory = rawDirectory.length <= 4_096 && !/[\u0000-\u001f\u007f]/u.test(rawDirectory)
    ? rawDirectory : '';
  const projectId = rawProject !== null && rawProject.length > 0 && rawProject.length <= 256
    && !/[\u0000-\u001f\u007f]/u.test(rawProject) ? rawProject : null;
  const mode = enabled && rawMode === 'session' && sessionId ? 'session' : 'draft';
  return { enabled, mode, sessionId: mode === 'session' ? sessionId : null, directory, projectId };
}
