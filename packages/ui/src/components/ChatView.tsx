import { useState } from 'react';
import { useSessionsStore } from '../stores/useSessionsStore.ts';
import { useI18n } from './I18nProvider.tsx';

export function ChatView() {
  const { t } = useI18n();
  const [draft, setDraft] = useState('');
  const session = useSessionsStore((s) => s.sessions.find((x) => x.id === s.selectedSessionId));
  const messages = useSessionsStore((s) => s.messages);
  const status = useSessionsStore((s) => (s.selectedSessionId ? s.sessionStatus[s.selectedSessionId] : undefined));
  const sendPending = useSessionsStore((s) => s.sendPending);
  const sendText = useSessionsStore((s) => s.sendText);

  const submit = async () => {
    const text = draft.trim();
    if (!text || sendPending) return;
    setDraft('');
    const result = await sendText(text);
    if (!result.ok && result.error) console.warn?.('[chat]', result.error);
  };

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {!session ? (
          <div className="mt-8 text-center text-sm text-neutral-600">{t('shell.noSession')}</div>
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-4">
            {status && status.type !== 'idle' ? (
              <div className="mx-auto rounded-full bg-amber-500/15 px-3 py-1 text-[11px] text-amber-400">
                {status.type === 'retry'
                  ? `retrying (${status.attempt}): ${status.message}`
                  : t('shell.busy')}
              </div>
            ) : null}
            {messages.map((message) => (
              <article key={message.id} className="text-sm">
                <div className="mb-1 text-[11px] uppercase tracking-wide text-neutral-500">
                  {message.role}
                </div>
                <div className="whitespace-pre-wrap break-words text-neutral-200">
                  {message.parts
                    .map((part) => (part.type === 'text' ? String(part.text ?? '') : ''))
                    .filter(Boolean)
                    .join('\n') || '(non-text part)'}
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      <footer className="border-t border-white/10 p-4">
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void submit();
              }
            }}
            placeholder={session ? t('shell.chatPlaceholder') : t('shell.noSession')}
            rows={2}
            className="min-h-[52px] flex-1 resize-none rounded-lg border border-white/10 bg-neutral-900 p-3 text-sm text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-white/25"
          />
          <button
            onClick={() => void submit()}
            disabled={sendPending || !session}
            className="rounded-lg bg-white/90 px-4 py-2 text-sm font-medium text-black disabled:opacity-40"
            type="button"
          >
            {t('shell.send')}
          </button>
        </div>
      </footer>
    </section>
  );
}

