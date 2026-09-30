// SPDX-License-Identifier: Apache-2.0
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { I18nProvider } from './components/I18nProvider.tsx';
import { ThemeProvider } from './components/ThemeProvider.tsx';
import { SessionAuthGate } from './components/auth/SessionAuthGate.tsx';
import { DesktopRelayPairingBridge } from './components/desktop/DesktopRelayPairingBridge.tsx';
import { DesktopRelayRuntimeRestore } from './components/desktop/DesktopRelayRuntimeRestore.tsx';
import { readMiniChatLaunch } from './lib/miniChatLaunch.ts';
import { useSessionViewStore } from './sync/view-store.ts';
import { getRuntimeKey } from './lib/runtime-switch.ts';
import type { LoginRequestBody, PasswordLoginResult } from './lib/sessionAuthGateState.ts';

// Doc 01 §4.3 provider tree, NND shape (E-08-50: this repo builds no
// ThemeSystemProvider): `I18nProvider > ThemeProvider > SessionAuthGate > App`
// — the gate renders App only after `/auth/session` says the session is live,
// so boot never races a lock (§6.6).
export function renderMainApp(element: HTMLElement): void {
  const launch = readMiniChatLaunch(window.location.search);
  if (launch.enabled) {
    useSessionViewStore.setState({
      activeDirectory: launch.directory,
      currentSessionId: launch.mode === 'session' ? launch.sessionId : null,
    });
  }
  const invokeDesktop = window.__NOTNATIVE_DESKTOP_INVOKE__;
  const loginPassword = invokeDesktop ? async (body: LoginRequestBody): Promise<PasswordLoginResult> => {
    const reply = await invokeDesktop('desktop_remote_password_login', {
      runtimeKey: getRuntimeKey(), password: body.password, trustDevice: body.trustDevice,
    });
    if (reply.ok && typeof reply.result === 'object' && reply.result !== null
      && typeof (reply.result as { ok?: unknown }).ok === 'boolean') return reply.result as PasswordLoginResult;
    return { ok: false, status: 0, locked: false, tunnelLocked: false, retryAfterSeconds: null, clientToken: null,
      error: typeof reply.error === 'string' ? reply.error : 'Desktop password login failed.' };
  } : undefined;
  createRoot(element).render(
    <StrictMode>
      <I18nProvider>
        <ThemeProvider>
          <DesktopRelayPairingBridge />
          <DesktopRelayRuntimeRestore />
          <SessionAuthGate loginPassword={loginPassword} issueClientToken={invokeDesktop !== undefined}>
            <App />
          </SessionAuthGate>
        </ThemeProvider>
      </I18nProvider>
    </StrictMode>,
  );
}
