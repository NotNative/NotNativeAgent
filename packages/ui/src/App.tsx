// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from 'react';
import { Toaster } from 'sonner';
import { fetchHealth, initializeApp } from './lib/initializeApp.ts';
import { removeSplashScreen } from './lib/splash.ts';
import { mountEngine } from './chat/app-engine.ts';
import { useFeatureFlagsStore } from './stores/useFeatureFlagsStore.ts';
import { useI18n } from './components/I18nProvider.tsx';
import { MainLayout } from './components/MainLayout.tsx';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function App() {
  const { t } = useI18n();
  const [initEpoch, setInitEpoch] = useState(0);
  const [initFailed, setInitFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const health = await fetchHealth();
      if (health && !cancelled) {
        useFeatureFlagsStore.getState().setPlanModeExperimentalEnabled(health.planModeExperimentalEnabled);
      }
      // doc 01 §4.3 step 4: ≤10 attempts, 1000ms base ×2, 16s cap → recovery
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
      mountEngine();
      removeSplashScreen();
      if (typeof window !== 'undefined') {
        window.__notnativeAppReady = true;
        window.dispatchEvent(new CustomEvent('notnative:app-ready'));
      }
    };
    void run();
    return () => { cancelled = true; };
  }, [initEpoch]);

  if (initFailed) {
    return (
      <div className="flex h-screen flex-col items-center gap-4 bg-neutral-900 p-8 pt-32 text-neutral-100">
        <div className="text-lg font-medium">{t('shell.recovery.title')}</div>
        <div className="text-sm text-neutral-500">The harness never reported healthy.</div>
        <button onClick={() => { setInitFailed(false); setInitEpoch((epoch) => epoch + 1); }}
          className="rounded-lg bg-white/90 px-4 py-2 text-sm font-medium text-black" type="button">
          {t('shell.recovery.retry')}
        </button>
      </div>
    );
  }

  return (
    <>
      <MainLayout />
      <Toaster position="bottom-right" />
    </>
  );
}
