import type { RuntimeAPIs, TerminalApi } from '@notnative/ui/lib/api/types.ts';

const notReady = (member: string) => () => {
  throw new Error(member + ' is not wired in the P0 web shell yet');
};

function createStubTerminal(): TerminalApi {
  return {
    createSession: async () => {
      throw new Error('terminal unsupported in web shell P0');
    },
    connect: () => ({ close: () => undefined }),
    sendInput: () => undefined,
    resize: () => undefined,
  };
}

async function loadSettings(): Promise<{ settings: Record<string, unknown>; source: 'desktop' | 'web' }> {
  try {
    const response = await fetch('/api/notnative/settings', { credentials: 'include' });
    if (!response.ok) return { settings: {}, source: 'web' };
    return (await response.json()) as { settings: Record<string, unknown>; source: 'web' };
  } catch {
    return { settings: {}, source: 'web' };
  }
}

async function saveSettings(changes: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch('/api/notnative/settings', {
    method: 'PUT',
    credentials: 'include',
    body: JSON.stringify(changes) ?? '{}',
    headers: { 'content-type': 'application/json' },
  }).catch(() => null);
  if (!response || !response.ok) return {};
  const body = (await response.json().catch(() => null)) as { settings?: Record<string, unknown> } | null;
  return body?.settings ?? {};
}

export function createWebAPIs(): RuntimeAPIs {
  return {
    runtime: { platform: 'web', isDesktop: false, isVSCode: false, label: 'web' },
    terminal: createStubTerminal(),
    git: new Proxy({}, { get: (_t, prop) => notReady(`git.${String(prop)}`) }),
    files: {
      listDirectory: notReady('files.listDirectory'),
      search: notReady('files.search'),
      createDirectory: notReady('files.createDirectory'),
    },

    settings: { load: loadSettings, save: saveSettings },
    permissions: {
      requestDirectoryAccess: async () => true,
      startAccessingDirectory: async () => undefined,
      stopAccessingDirectory: async () => undefined,
    },
    notifications: {
      async notifyAgentCompletion(payload) {
        try {
          if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
            return false;
          }
          new Notification(payload?.title ?? 'NotNativeDesktop', { body: payload?.body ?? '' });
          return true;
        } catch {
          return false;
        }
      },
      canNotify() {
        return typeof Notification !== 'undefined' && Notification.permission === 'granted';
      },
    },
    tools: {
      async getAvailableTools() {
        return ['mock-read', 'mock-echo'];
      },
    },
  };
}

