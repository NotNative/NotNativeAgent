// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from 'react';
import { Toaster } from 'sonner';
import { fetchHealth, initializeApp } from './lib/initializeApp.ts';
import { removeSplashScreen } from './lib/splash.ts';
import { mountEngine } from './chat/app-engine.ts';
import { installAuthSessionFocusWatch } from './lib/runtime-auth-expiry.ts';
import { useFeatureFlagsStore } from './stores/useFeatureFlagsStore.ts';
import { useI18n } from './components/I18nProvider.tsx';
import { MainLayout } from './components/MainLayout.tsx';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** doc 01 §4.3 step 4: fetchHealth flag, then ≤10 init attempts (1 s ×2, 16 s
 *  cap → manual recovery). The boot phase runs once per init epoch. */
async function runBootPhase(isCancelled: () => boolean, onRecovery: () => void): Promise<void> {
  const health = await fetchHealth();
  if (health && !isCancelled()) {
    useFeatureFlagsStore.getState().setPlanModeExperimentalEnabled(health.planModeExperimentalEnabled);
  }
  let ok = false;
  let delay = 1000;
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    ok = await initializeApp();
    if (ok || isCancelled()) break;
    await sleep(delay);
    delay = Math.min(delay * 2, 16_000);
  }
  if (isCancelled()) return;
  if (!ok) { onRecovery(); return; }
  mountEngine();
  removeSplashScreen();
  if (typeof window !== 'undefined') {
    window.__notnativeAppReady = true;
    window.dispatchEvent(new CustomEvent('notnative:app-ready'));
  }
}

export function App() {
  const { t } = useI18n();
  const [initEpoch, setInitEpoch] = useState(0);
  const [initFailed, setInitFailed] = useState(false);

  useEffect(() => {
    // §2.8/§6.7 step 6: focus revalidation so a fresh tab is honest after a
    // long suspension — one request per wake, ≥5 min throttle inside the watch.
    return installAuthSessionFocusWatch();
  }, []);

  useEffect(() => {
    let cancelled = false;
    void runBootPhase(() => cancelled, () => { setInitFailed(true); removeSplashScreen(); });
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
