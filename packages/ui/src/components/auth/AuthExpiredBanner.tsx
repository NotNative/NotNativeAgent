// SPDX-License-Identifier: Apache-2.0
/**
 * AuthExpiredBanner (doc 08 §6.7).
 *
 * Non-blocking banner rendered *under* the header when the shared
 * `useAuthSessionStore` flips to `expired` mid-session. Three rules it must
 * not break:
 *
 * 1. It renders nothing unless the store actually says `expired`. The store is
 *    already confirmed — `runtimeFetch` debounces one `GET /auth/session` probe
 *    per 15 s window before `markExpired` — so the banner must not probe again,
 *    or a dead provider key (whose 401s are *not* our session) would blink it.
 * 2. It never blocks. No overlay, no focus trap, no scroll lock: the composer
 *    send guard is what stops sends (§6.7 step 3), and mobile orchestration
 *    feeds its own connection flow.
 * 3. "Log in" only sets `reauthenticating` (§2.8/§6.7 step 4). The gate
 *    subscribes to that state and re-runs its own status check, which lands a
 *    genuine 401 in the full locked flow. The banner must not try to log in,
 *    cache credentials, or guess a redirect.
 */
import { useCallback, type ReactNode } from 'react';
import { useAuthSessionStore } from '../../lib/runtime-auth-expiry.ts';
import type { AuthSessionState } from '../../lib/runtime-auth-expiry.ts';

export interface AuthExpiredBannerProps {
  /** Test seam: render while a specific state is active. Defaults to 'expired'. */
  visibleIn?: readonly AuthSessionState[];
  /**
   * Override the state reader instead of the live store (used by the shell in
   * tests and by any surface that mirrors the store).
   */
  readState?: () => AuthSessionState;
  /** Called after the store flips to `reauthenticating` (host-side retargeting). */
  onBeginLogin?: () => void;
  label?: {
    title?: string;
    body?: string;
    action?: string;
  };
}

const DEFAULT_VISIBLE_IN: readonly AuthSessionState[] = ['expired'];

const DEFAULT_LABELS = {
  title: 'Session expired',
  body: 'Your session on this server has ended. Log in again to continue.',
  action: 'Log in',
} as const;

export function AuthExpiredBanner({
  visibleIn = DEFAULT_VISIBLE_IN,
  readState,
  onBeginLogin,
  label,
}: AuthExpiredBannerProps): ReactNode {
  // One subscription: the same zustand store every other consumer reads, so a
  // successful login (markOk) removes this banner without any extra plumbing.
  const storeState = useAuthSessionStore((state) => state.status);
  const beginReauthentication = useAuthSessionStore((state) => state.beginReauthentication);
  const state = readState !== undefined ? readState() : storeState;
  const visible = visibleIn.includes(state);

  const beginLogin = useCallback((): void => {
    beginReauthentication();
    onBeginLogin?.();
  }, [beginReauthentication, onBeginLogin]);

  if (!visible) return null;
  const text = { ...DEFAULT_LABELS, ...(label ?? {}) };
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="auth-expired-banner"
      data-auth-session-state={state}
      className="sticky top-[var(--oc-header-height,0px)] z-30 flex w-full items-center gap-3 border-b border-border/60 bg-amber-500/10 px-4 py-2 text-sm text-foreground"
    >
      <span aria-hidden="true" className="shrink-0 text-amber-500">
        &#33;
      </span>
      <span className="min-w-0 flex-1">
        <span className="font-medium">{text.title}</span>
        <span className="ms-2 text-muted-foreground">{text.body}</span>
      </span>
      <button
        type="button"
        onClick={beginLogin}
        data-testid="auth-expired-banner-login"
        className="ms-auto shrink-0 rounded-md border border-border/60 px-3 py-1 text-xs hover:bg-muted"
      >
        {text.action}
      </button>
    </div>
  );
}

export default AuthExpiredBanner;
