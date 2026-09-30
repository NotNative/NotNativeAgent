// SPDX-License-Identifier: Apache-2.0
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { I18nProvider } from './components/I18nProvider.tsx';
import { ThemeProvider } from './components/ThemeProvider.tsx';
import { SessionAuthGate } from './components/auth/SessionAuthGate.tsx';
import { DesktopRelayPairingBridge } from './components/desktop/DesktopRelayPairingBridge.tsx';
import { DesktopRelayRuntimeRestore } from './components/desktop/DesktopRelayRuntimeRestore.tsx';

// Doc 01 §4.3 provider tree, NND shape (E-08-50: this repo builds no
// ThemeSystemProvider): `I18nProvider > ThemeProvider > SessionAuthGate > App`
// — the gate renders App only after `/auth/session` says the session is live,
// so boot never races a lock (§6.6).
export function renderMainApp(element: HTMLElement): void {
  createRoot(element).render(
    <StrictMode>
      <I18nProvider>
        <ThemeProvider>
          <DesktopRelayPairingBridge />
          <DesktopRelayRuntimeRestore />
          <SessionAuthGate>
            <App />
          </SessionAuthGate>
        </ThemeProvider>
      </I18nProvider>
    </StrictMode>,
  );
}
