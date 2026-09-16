// SPDX-License-Identifier: Apache-2.0
/**
 * Splash lifecycle (doc 01 §4.1/§5.2/§10.1): the HTML owns rendering; the UI
 * owns dismissal gates. Dismiss = fade-out class (300 ms) then removal, with a
 * ≥150 ms grace before the fade starts.
 */
const SPLASH_ID = 'initial-loading';
const FADE_MS = 300;
const GRACE_MS = 150;

let dismissed = false;

export function removeSplashScreen(): void {
  if (dismissed || typeof document === 'undefined') return;
  dismissed = true;
  const splash = document.getElementById(SPLASH_ID);
  if (!splash) return;
  setTimeout(() => {
    splash.classList.add('fade-out');
    setTimeout(() => splash.remove(), FADE_MS);
  }, GRACE_MS);
}

/** Non-desktop fallback: never leave the user staring at a splash forever. */
export function scheduleSplashFallback(ms: number): void {
  if (typeof window === 'undefined') return;
  setTimeout(() => removeSplashScreen(), ms);
}

export const isSplashDismissed = (): boolean => dismissed;
