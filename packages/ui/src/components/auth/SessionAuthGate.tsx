// SPDX-License-Identifier: Apache-2.0
/**
 * SessionAuthGate (doc 08 §6.6).
 *
 * Presentational shell over the tested state helper (`sessionAuthGateState.ts`):
 * which stage renders, whether a password field may appear, and how long until
 * the limiter releases are that module's answers, never this file's invention.
 * The split is the point — `locked`, `tunnel-locked`, `rate-limited` and
 * `error` differ by one payload flag each and are unit-tested as data.
 *
 * Contract honored here:
 * - re-probes on mount and on every runtime-endpoint change, cancelling any
 *   ceremony and clearing password + error + retry budget (§6.6.1);
 * - `tunnel-locked` renders NO credential field (§2.9 hard-403s tunnel-scope
 *   passwords, so a form here would only teach users to fail);
 * - a cancelled ceremony is silent (§6.6.4) and passkey busy is tracked apart
 *   from submit busy, so switching inputs cancels instead of queueing;
 * - a fresh `probeSessionGate` is used for the §6.7 re-entry — never a cache.
 *
 * Known deferrals (typed seams, no fake implementations):
 * - desktop remote password login (§6.6.3) goes through `invokeDesktop(
 *   'desktop_remote_password_login')` in doc 09, which does not exist in this
 *   repo yet; that surface is the `loginPassword` prop instead;
 * - strings are injected via `labels` because `t()` takes only registered
 *   `I18nKey`s and `useI18n()` throws outside its provider. Registering the
 *   auth keys in `lib/i18n/messages/en.ts` is a follow-up.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { setRuntimeBearerToken } from '../../lib/runtime-auth.ts';
import { useAuthSessionStore, type AuthSessionState } from '../../lib/runtime-auth-expiry.ts';
import { getRuntimeKey, onRuntimeEndpointChanged } from '../../lib/runtime-switch.ts';
import { removeSplashScreen } from '../../lib/splash.ts';
import {
  authenticateWithPasskey,
  registerCurrentDevicePasskey,
  type PasskeySupportState,
} from '../../lib/passkeys.ts';
import {
  beginGateReauthentication,
  createSessionGateRuntime,
  loginWithPassword,
  markGateAuthenticated,
  probeSessionGate,
  UNKNOWN_PRESENCE,
  type LoginRequestBody,
  type PasskeyPresence,
  type PasswordLoginResult,
  type SessionGateRuntime,
  type SessionGateView,
  type SessionProbe,
} from '../../lib/sessionAuthGateState.ts';
import {
  fetchPasskeyPresence,
  NO_SUPPORT,
  resetGateAndProbe,
  sessionGateView,
} from '../../lib/sessionAuthGateView.ts';
import { readTrustDevice, rememberTrustDevice } from '../../lib/sessionAuthGateTrust.ts';
import {
  GATE_TEXT,
  PENDING_PROBE,
  describeLoginFailure,
  headingFor,
  resolveGateText,
  type GateText,
} from './gateText.ts';

export interface SessionAuthGateProps {
  children?: ReactNode;
  /** Full escape hatch for the VS Code surface (§6.6 "VS Code skips it"). */
  skipAuth?: boolean;
  /** Host/test seam: replaces fetch, sleep, storage and the ceremony faces. */
  runtime?: SessionGateRuntime;
  /**
   * Desktop override for password submission when the runtime targets a remote
   * host (§6.6.3). Receives exactly the body the plain path would send.
   */
  loginPassword?: (body: LoginRequestBody) => Promise<PasswordLoginResult>;
  /** Inline host switcher, rendered on the locked/error screens (desktop). */
  hostSwitcher?: ReactNode;
  /** Local-shell case: ask the server for a device token (§6.6.3). */
  issueClientToken?: boolean;
  /** Test seam so a 4-retry run does not cost 15 s in a component test. */
  sleep?: (ms: number) => Promise<void>;
  labels?: Partial<GateText>;
}

type GateBusy = 'none' | 'submit' | 'passkey';

export function SessionAuthGate(props: SessionAuthGateProps): ReactNode {
  const runtime = useGateRuntime(props);
  const model = useGateModel(runtime, props.skipAuth === true);
  const actions = useGateActions(runtime, model, props);
  const text = resolveGateText(props.labels);

  if (props.skipAuth === true) return props.children ?? null;
  const view = sessionGateView(model.probe ?? PENDING_PROBE, model.support ?? NO_SUPPORT, model.presence);
  if (view.stage === 'authenticated') return props.children ?? null;
  return (
    <GateScreen
      view={view}
      model={model}
      actions={actions}
      text={text}
      hostSwitcher={props.hostSwitcher}
    />
  );
}

function useGateRuntime(props: SessionAuthGateProps): SessionGateRuntime {
  return useMemo(
    () => props.runtime ?? createSessionGateRuntime(props.sleep === undefined ? {} : { sleep: props.sleep }),
    [props.runtime, props.sleep],
  );
}

/** Removes the HTML splash once the first probe answered (any stage). */
function useSplashReleaseOnResolution(probe: SessionProbe | null): void {
  useEffect(() => {
    if (probe === null) return;
    removeSplashScreen();
  }, [probe]);
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

function useGateModel(runtime: SessionGateRuntime, skipAuth: boolean) {
  const [probe, setProbe] = useState<SessionProbe | null>(null);
  const [support, setSupport] = useState<PasskeySupportState | null>(null);
  const [presence, setPresence] = useState<PasskeyPresence>(UNKNOWN_PRESENCE);
  const [password, setPasswordValue] = useState('');
  const [trustDevice, setTrustDevice] = useTrustDevicePreference(runtime);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [busy, setBusy] = useState<GateBusy>('none');
  const generation = useRef(0);
  const runtimeKey = getRuntimeKey();
  const storeStatus = useAuthSessionStore((state) => state.status);

  const resetAndProbe = useCallback(
    () => resetGateAndProbe(runtime, generation, {
      setPasswordValue, setInlineError, setBusy, setPresence, setSupport, setProbe,
    }),
    [runtime],
  );

  useEffect(() => {
    if (skipAuth) return undefined;
    void resetAndProbe();
    const off = onRuntimeEndpointChanged(() => { void resetAndProbe(); });
    return () => { off(); generation.current += 1; };
  }, [resetAndProbe, runtimeKey, skipAuth]);

  // §6.7 step 4: the banner's "Log in" arrives as `reauthenticating`, and the
  // gate re-runs its own status check — a genuine 401 lands in the full lock.
  useReauthenticationEntry(runtime, skipAuth, storeStatus, generation, setProbe);
  // The splash overlay serves only the pre-gate boot; once the probe answers
  // (any stage), the gate screen itself is the UI and the splash must yield.
  useSplashReleaseOnResolution(probe);

  return {
    probe,
    support,
    presence,
    password,
    inlineError,
    busy,
    trustDevice,
    generation,
    setPasswordValue,
    setTrustDevice,
    setInlineError,
    setBusy,
    setPresence,
    refresh: resetAndProbe,
  };
}

type GateModel = ReturnType<typeof useGateModel>;

/**
 * "Trust this device" is a browser preference (§6.6 step 2), persisted the
 * moment it is toggled — a tunnel-locked screen never posts a password, so
 * persisting only on submit would silently drop the choice.
 */
function useTrustDevicePreference(runtime: SessionGateRuntime): [boolean, (trusted: boolean) => void] {
  const [trusted, setTrusted] = useState(() => readTrustDevice(runtime));
  const persist = useCallback((next: boolean): void => {
    setTrusted(next);
    rememberTrustDevice(runtime, next);
  }, [runtime]);
  return [trusted, persist];
}

/**
 * §6.7 step 4. The banner's "Log in" only sets `reauthenticating`; the gate is
 * the one that asks the server again. A live session clears the shared store
 * back to `ok` (the banner disappears); anything else leaves the store where
 * the banner put it and the locked screen takes over — a lock (tunnel lock
 * included) is not a successful login, so §6.6 step 5's markOk is reserved
 * for the `authenticated` stage only.
 */
function useReauthenticationEntry(
  runtime: SessionGateRuntime,
  skipAuth: boolean,
  storeStatus: AuthSessionState,
  generation: { current: number },
  setProbe: (probe: SessionProbe) => void,
): void {
  useEffect(() => {
    if (skipAuth || storeStatus !== 'reauthenticating') return;
    const mine = generation.current;
    void probeSessionGate(runtime).then((outcome) => {
      if (outcome.stage === 'authenticated') markGateAuthenticated();
      if (generation.current === mine) setProbe(outcome);
    });
  }, [generation, runtime, setProbe, skipAuth, storeStatus]);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function useGateActions(
  runtime: SessionGateRuntime,
  model: GateModel,
  props: SessionAuthGateProps,
) {
  const settleSuccess = useCallback((): void => {
    model.setPasswordValue('');
    model.setBusy('none');
    model.setInlineError(null);
    markGateAuthenticated();
    void model.refresh();
  }, [model]);

  const submitPassword = useCallback(async (): Promise<void> => {
    if (model.password.length === 0 || model.busy !== 'none') return;
    model.setBusy('submit');
    model.setInlineError(null);
    const body: LoginRequestBody = {
      password: model.password,
      trustDevice: model.trustDevice,
      ...(props.issueClientToken === true ? { issueClientToken: true } : {}),
    };
    const outcome = props.loginPassword === undefined
      ? await loginWithPassword(runtime, body)
      : await props.loginPassword(body);
    if (outcome.ok) {
      if (outcome.clientToken !== null) setRuntimeBearerToken(outcome.clientToken);
      settleSuccess();
      return;
    }
    model.setBusy('none');
    model.setInlineError(describeLoginFailure(outcome, props.labels));
    if (outcome.status === 429 || outcome.locked || outcome.tunnelLocked) await model.refresh();
  }, [model, props, runtime, settleSuccess]);

  const passkey = usePasskeyActions(runtime, model, props.issueClientToken === true, settleSuccess);
  const retry = useCallback((): void => {
    beginGateReauthentication();
    void model.refresh();
  }, [model]);

  return { submitPassword, usePasskey: passkey.unlock, addPasskey: passkey.enroll, retry };
}

/**
 * §6.6.4: the ceremony has its own busy flag, so a second click cancels the
 * running ceremony instead of stacking another one, and a cancelled ceremony is
 * silent — no error line.
 */
function usePasskeyActions(
  runtime: SessionGateRuntime,
  model: GateModel,
  issueClientToken: boolean,
  settleSuccess: () => void,
) {
  const unlock = useCallback(async (): Promise<void> => {
    if (model.busy === 'passkey') {
      runtime.abortService.cancelCeremony();
      model.setBusy('none');
      return;
    }
    model.setBusy('passkey');
    model.setInlineError(null);
    const result = await authenticateWithPasskey(
      runtime,
      model.trustDevice,
      issueClientToken ? { issueClientToken: true } : undefined,
    );
    if (result.ok) {
      if (result.clientToken !== null) setRuntimeBearerToken(result.clientToken);
      settleSuccess();
      return;
    }
    model.setBusy('none');
    if (result.error === 'cancelled') return; // silent cancel, never an error line
    model.setInlineError(result.error ?? 'Passkey sign-in failed');
    if (result.locked === true || result.status === 429) await model.refresh();
  }, [issueClientToken, model, runtime, settleSuccess]);

  const enroll = useCallback(async (): Promise<void> => {
    model.setBusy('passkey');
    model.setInlineError(null);
    const result = await registerCurrentDevicePasskey(runtime);
    model.setBusy('none');
    if (result.ok) {
      model.setPresence(await fetchPasskeyPresence(runtime));
      return;
    }
    if (result.error === 'cancelled') return;
    model.setInlineError(result.error ?? 'Could not add a passkey');
  }, [model, runtime]);

  return { unlock, enroll };
}

type GateActions = ReturnType<typeof useGateActions>;


// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

interface GateScreenProps {
  view: SessionGateView;
  model: GateModel;
  actions: GateActions;
  text: GateText;
  hostSwitcher?: ReactNode;
}

function GateScreen({ view, model, actions, text, hostSwitcher }: GateScreenProps): ReactNode {
  if (view.stage === 'pending') {
    return (
      <div role="status" aria-live="polite" data-testid="session-gate-pending" className="flex min-h-screen items-center justify-center">
        <span className="text-sm text-muted-foreground">{text.pending}</span>
      </div>
    );
  }
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <form
        onSubmit={(event) => { event.preventDefault(); void actions.submitPassword(); }}
        data-testid="session-auth-gate"
        data-stage={view.stage}
        className="w-full max-w-sm rounded-xl border border-border/60 bg-background p-5 shadow-lg"
      >
        <h1 className="text-base font-medium">{headingFor(view.stage, text)}</h1>
        {view.tunnelExplanation === true ? (
          <p className="mt-2 text-sm text-muted-foreground" data-testid="gate-tunnel-note">{text.tunnelBody}</p>
        ) : null}
        {view.passwordForm === true ? <PasswordFields model={model} text={text} /> : null}
        {view.passkeysDisabledHint === true ? (
          <p className="mt-2 text-xs text-muted-foreground" data-testid="gate-passkeys-disabled">{text.passkeysDisabled}</p>
        ) : null}
        {model.inlineError !== null ? (
          <p role="alert" data-testid="gate-error" className="mt-2 text-xs text-destructive">{model.inlineError}</p>
        ) : null}
        <GateButtons view={view} model={model} actions={actions} text={text} />
        {view.retryable === true && hostSwitcher !== undefined ? hostSwitcher : null}
      </form>
    </div>
  );
}


function PasswordFields({ model, text }: { model: GateModel; text: GateText }): ReactNode {
  return (
    <>
      <label className="mt-3 block text-xs text-muted-foreground" htmlFor="session-gate-password">
        {text.passwordLabel}
      </label>
      <input
        id="session-gate-password"
        type="password"
        autoFocus
        autoComplete="current-password"
        value={model.password}
        // §6.6 step 2: "autofocus + select".
        onFocus={(event) => { event.currentTarget.select(); }}
        onChange={(event) => { model.setPasswordValue(event.target.value); }}
        data-testid="gate-password"
        className="mt-1 w-full rounded-md border border-border/60 bg-transparent px-3 py-2 text-sm"
      />
      <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          checked={model.trustDevice}
          onChange={(event) => { model.setTrustDevice(event.target.checked); }}
          data-testid="gate-trust-device"
        />
        {text.trustDevice}
      </label>
    </>
  );
}

function GateButtons({ view, model, actions, text }: {
  view: SessionGateView;
  model: GateModel;
  actions: GateActions;
  text: GateText;
}): ReactNode {
  const submitting = model.busy === 'submit';
  const passkeyBusy = model.busy === 'passkey';
  return (
    <div className="mt-4 flex flex-wrap items-center gap-2">
      {view.passwordForm === true ? (
        <button
          type="submit"
          disabled={submitting || model.password.length === 0}
          data-testid="gate-submit"
          className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
        >
          {submitting ? text.unlocking : text.unlock}
        </button>
      ) : null}
      {view.passkeyUnlock === true ? (
        <button
          type="button"
          onClick={() => { void actions.usePasskey(); }}
          data-busy={passkeyBusy ? 'true' : 'false'}
          data-testid="gate-passkey"
          className="rounded-md border border-border/60 px-3 py-2 text-sm hover:bg-muted"
        >
          {passkeyBusy ? text.authenticating : text.usePasskey}
        </button>
      ) : null}
      {view.passkeyEnroll === true ? (
        <button
          type="button"
          onClick={() => { void actions.addPasskey(); }}
          disabled={passkeyBusy}
          data-testid="gate-passkey-add"
          className="rounded-md border border-border/60 px-3 py-2 text-xs hover:bg-muted"
        >
          {text.addPasskey}
        </button>
      ) : null}
      {view.retryable === true ? (
        <button
          type="button"
          onClick={actions.retry}
          data-testid="gate-retry"
          className="rounded-md border border-border/60 px-3 py-2 text-xs hover:bg-muted"
        >
          {view.retryLine ?? text.retry}
        </button>
      ) : null}
    </div>
  );
}

export default SessionAuthGate;
