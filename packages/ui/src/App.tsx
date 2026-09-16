import { useEffect, useState } from 'react';
import { Toaster, toast } from 'sonner';
import { fetchHealth, initializeApp } from './lib/initializeApp.ts';
import { removeSplashScreen } from './lib/splash.ts';
import { subscribeControlEvents, subscribeHarnessEvents } from './lib/nna/events.ts';
import type { SessionStatus } from './lib/nna/types.ts';
import { useConfigStore } from './stores/useConfigStore.ts';
import { useFeatureFlagsStore } from './stores/useFeatureFlagsStore.ts';
import { useSessionsStore } from './stores/useSessionsStore.ts';
import { useI18n } from './components/I18nProvider.tsx';
import { MainLayout } from './components/MainLayout.tsx';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function App() {
  const { t } = useI18n();
  const [initEpoch, setInitEpoch] = useState(0);
  const [initFailed, setInitFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const cleanups: Array<() => void> = [];
    const run = async () => {

      const health = await fetchHealth();
      if (health && !cancelled) {
        useFeatureFlagsStore
          .getState()
          .setPlanModeExperimentalEnabled(health.planModeExperimentalEnabled);
      }

      // doc 01 §4.3 step 4: ≤10 attempts, 1000 ms base doubling, 16 s cap,
      // exhausted → manual recovery screen (never a dead splash, §16.10).
      let ok = false;
      let delay = 1000;
      for (let attempt = 1; attempt <= 10; attempt += 1) {
        ok = await initializeApp();
        if (ok || cancelled) break;
        await sleep(delay);
        delay = Math.min(delay * 2, 16_000);
      }
      if (cancelled) return;
      if (!ok) {
        setInitFailed(true);
        removeSplashScreen();
        return;
      }

      void useSessionsStore.getState().loadSessions().then(() => useSessionsStore.getState().refreshStatus());
      removeSplashScreen();
      if (typeof window !== 'undefined') {
        window.__notnativeAppReady = true;
        window.dispatchEvent(new CustomEvent('notnative:app-ready'));
      }

      void subscribeHarnessEvents((event) => {
        const sessions = useSessionsStore.getState();
        switch (event.type) {
          case 'session.created':
          case 'session.updated':
          case 'session.deleted':
            void sessions.loadSessions();
            break;
          case 'message.updated':
          case 'message.part.updated':
          case 'message.removed':
          case 'message.part.removed':
            void sessions.refreshMessages();
            break;
          case 'session.status': {
            const sessionId = event.properties?.sessionID;
            const status = event.properties?.status as SessionStatus | undefined;
            if (typeof sessionId === 'string' && status) sessions.applyStatusEvent(sessionId, status);
            break;
          }
          case 'session.idle':
            void sessions.refreshStatus();
            break;
          case 'permission.asked':
            toast.message(`Permission requested (${String(event.properties?.permission ?? '?')}) — reply surface lands in P2`);
            break;
          case 'question.asked':
            toast.message('Harness asked a question — answer card lands in P2');
            break;
          case 'session.error': {
            const error = event.properties?.error as { name?: string } | undefined;
            toast.error(`Turn error: ${error?.name ?? 'unknown'}`);
            break;
          }
          default:
            break;
        }
      }).then((unsubscribe) => {
        if (cancelled) unsubscribe();
        else cleanups.push(unsubscribe);
      });

      void subscribeControlEvents(() => undefined).then((unsubscribe) => {
        if (cancelled) unsubscribe();
        else cleanups.push(unsubscribe);
      });

      // step 5: providers/agents recovery — 2 s poll, 15 attempts, while empty
      let ticks = 0;
      const poll = setInterval(() => {
        ticks += 1;
        const state = useConfigStore.getState();
        if ((state.providers.length > 0 && state.agents.length > 0) || ticks >= 15) {
          clearInterval(poll);
          return;
        }
        void state.loadProviders();
        void state.loadAgents();
      }, 2000);
      cleanups.push(() => clearInterval(poll));

    };
    void run();
    return () => {
      cancelled = true;
      for (const cleanup of cleanups) cleanup();
    };
  }, [initEpoch]);

  if (initFailed) {
    return (
      <div className="flex h-screen flex-col items-center gap-4 bg-neutral-900 p-8 pt-32 text-neutral-100">
        <div className="text-lg font-medium">{t('shell.recovery.title')}</div>
        <div className="text-sm text-neutral-500">The harness never reported healthy.</div>
        <button
          onClick={() => {
            setInitFailed(false);
            setInitEpoch((epoch) => epoch + 1);
          }}
          className="rounded-lg bg-white/90 px-4 py-2 text-sm font-medium text-black"
          type="button"
        >
          {t('shell.recovery.retry')}
        </button>
      </div>
    );
  }

  return (
    <>
      <MainLayout />
      <div
        style={{
          position: 'fixed',
          bottom: 8,
          left: '50%',
          transform: 'translateX(-50%)',
          pointerEvents: 'none',
        }}
        className="rounded-full bg-amber-500/15 px-3 py-1 text-[11px] text-amber-400"
      >
        {t('shell.mockBanner')}
      </div>
      <Toaster position="bottom-right" />
    </>
  );
}

