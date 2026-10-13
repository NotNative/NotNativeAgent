// SPDX-License-Identifier: Apache-2.0
import { harnessClient } from '../lib/nnd/client.ts';
import { useI18n } from './I18nProvider.tsx';
import { useSessionsStore } from '../stores/useSessionsStore.ts';

export function SessionSidebar() {
  const { t } = useI18n();
  const sessions = useSessionsStore((s) => s.sessions);
  const selectedId = useSessionsStore((s) => s.selectedSessionId);
  const selectSession = useSessionsStore((s) => s.selectSession);

  const createSession = async () => {
    const result = await harnessClient.createSession({ title: 'New session' });
    if (result.data) {
      await useSessionsStore.getState().loadSessions();
      await selectSession(result.data.id);
    }
  };

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-white/10 bg-neutral-950">
      <div className="flex items-center justify-between px-3 py-2 text-[11px] uppercase tracking-wide text-neutral-500">
        <span>{t('shell.sessions')}</span>
        <button onClick={createSession} className="text-neutral-300 hover:text-white" type="button">
          + {t('shell.newSession')}
        </button>
      </div>

      <ul className="flex-1 overflow-y-auto">
        {sessions.map((session) => (
          <li key={session.id}>
            <button
              onClick={() => void selectSession(session.id)}
              className={`w-full truncate px-3 py-2 text-left text-sm ${
                selectedId === session.id
                  ? 'bg-neutral-800 text-white'
                  : 'text-neutral-400 hover:bg-neutral-900'
              }`}
            >
              {session.title}
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}

