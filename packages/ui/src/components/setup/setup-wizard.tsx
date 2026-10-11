// SPDX-License-Identifier: Apache-2.0
/**
 * Unified guided setup wizard (W-14, doc 05 §B): one flow orchestrating the
 * three previously separate surfaces — detection (native setup status),
 * setup (activation with streamed status), and recovery (explicit retry of
 * detection or activation with the surfaced failure code). Remote setup is
 * excluded by contract: the wizard only ever drives the local
 * /api/v1/nnd/setup routes and the local harness readiness probe.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { requestNativeSetup, type NativeSetupStatus } from '../../lib/nnd/setup.ts';
import { waitForNativeModelReady } from '../../lib/nnd/setup-readiness.ts';
import { useAuthSessionStore } from '../../lib/runtime-auth-expiry.ts';

export type WizardStep = 'detect' | 'setup' | 'verify' | 'recover' | 'done';

function classify(status: NativeSetupStatus | null, error: boolean): { step: WizardStep; problem: string | null } {
  if (error || status === null) return { step: 'recover', problem: 'detection-failed' };
  if (status.service_state === 'ready' && status.execution_state === 'ready') return { step: 'verify', problem: null };
  if (status.service_state === 'failed') return { step: 'recover', problem: status.failure_code ?? 'service-failed' };
  if (status.service_state === 'setup_required' || status.service_state === 'stopped'
    || status.service_state === 'stopping' || status.configuration_state !== 'ready') return { step: 'setup', problem: status.failure_code };
  // starting: still in setup, streaming continues there.
  return { step: 'setup', problem: null };
}

export function SetupWizard({ onVerified, initial = true }: { onVerified?: (signal: AbortSignal) => Promise<void> | void; initial?: boolean } = {}): ReactNode {
  const auth = useAuthSessionStore((state) => state.status);
  const [step, setStep] = useState<WizardStep>(initial ? 'detect' : 'setup');
  const [status, setStatus] = useState<NativeSetupStatus | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [verified, setVerified] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const active = useRef(true);

  useEffect(() => {
    active.current = true;
    return () => { active.current = false; pending.current?.abort(); };
  }, []);

  const detect = useCallback(async (): Promise<void> => {
    if (auth !== 'ok' || pending.current) return;
    const controller = new AbortController(); pending.current = controller;
    setBusy(true); setProblem(null);
    try {
      const result = await requestNativeSetup(false, controller.signal);
      if (!active.current) return;
      const verdict = classify(result.status, result.error);
      setStatus(result.status); setProblem(verdict.problem); setStep(verdict.step);
    } catch {
      if (active.current) { setProblem('detection-failed'); setStep('recover'); }
    } finally {
      if (active.current && pending.current === controller) { pending.current = null; setBusy(false); }
    }
  }, [auth]);

  // Guided entry: run detection on mount (unless the caller drops straight
  // into a known step with `initial = false`).
  useEffect(() => {
    if (initial) void detect();
  }, [initial, detect]);

  const setup = useCallback(async (): Promise<void> => {
    if (auth !== 'ok' || pending.current) return;
    const controller = new AbortController(); pending.current = controller;
    setBusy(true); setProblem(null); setStep('setup');
    try {
      const result = await requestNativeSetup(true, controller.signal);
      if (!active.current) return;
      const verdict = classify(result.status, result.error);
      setStatus(result.status);
      if (verdict.step === 'verify' && result.status !== null) { setStep('verify'); }
      else { setProblem(verdict.problem ?? 'activation-incomplete'); setStep('recover'); }
    } catch {
      if (active.current) { setProblem('activation-failed'); setStep('recover'); }
    } finally {
      if (active.current && pending.current === controller) { pending.current = null; setBusy(false); }
    }
  }, [auth]);

  // Verify: the harness must expose the activated NNA model before "done".
  useEffect(() => {
    if (step !== 'verify' || auth !== 'ok' || verified) return;
    const controller = new AbortController(); pending.current = controller;
    void (async () => {
      try {
        await waitForNativeModelReady(controller.signal);
        if (!active.current) return;
        await onVerified?.(controller.signal);
        if (!active.current) return;
        setVerified(true); setStep('done'); setBusy(false);
      } catch (error) {
        if (!active.current) return;
        setProblem(error instanceof Error && error.message === 'native-setup-cancelled' ? null : 'model-not-ready');
        setStep('recover'); setBusy(false);
      } finally {
        if (pending.current === controller) pending.current = null;
      }
    })();
    return () => controller.abort();
  }, [step, auth, verified, onVerified]);

  const busyText = step === 'setup' ? 'Activating NNA…' : step === 'verify' ? 'Waiting for the NNA model…' : 'Detecting…';
  return (
    <div className="rounded-lg border border-white/10 bg-neutral-900/40 p-4" data-testid="setup-wizard">
      <h3 className="mb-2 text-sm font-medium text-neutral-200">Setup wizard</h3>
      <ol className="mb-3 flex gap-2 text-[11px] text-neutral-500" aria-label="Wizard steps">
        {(['detect', 'setup', 'verify', 'done'] as const).map((entry, index) => (
          <li key={entry} data-testid={`wizard-step-${entry}`}
            aria-current={step === entry ? 'step' : undefined}
            className={step === entry ? 'text-neutral-200' : (step === 'done' || ['detect', 'setup', 'verify'].indexOf(step) > index ? 'text-emerald-400/80' : '')}>
            {index + 1}. {entry === 'detect' ? 'Detect' : entry === 'setup' ? 'Set up' : entry === 'verify' ? 'Verify' : 'Ready'}
          </li>
        ))}
      </ol>
      {step === 'done' ? <p className="text-sm text-emerald-300" data-testid="wizard-done">NNA is ready. Model attached and verified.</p> : null}
      {step === 'recover' ? (
        <div className="flex flex-col gap-2" data-testid="wizard-recovery">
          <p className="text-sm text-amber-300" role="alert">
            Setup needs attention{problem ? ` (${problem})` : ''}.
          </p>
          <div className="flex gap-2">
            <button type="button" data-testid="wizard-retry-detection" disabled={busy}
              className="rounded border border-white/15 px-3 py-1.5 text-xs text-neutral-200 hover:bg-white/10 disabled:opacity-50"
              onClick={() => void detect()}>Retry detection</button>
            <button type="button" data-testid="wizard-retry-activation" disabled={busy}
              className="rounded border border-white/15 px-3 py-1.5 text-xs text-neutral-200 hover:bg-white/10 disabled:opacity-50"
              onClick={() => void setup()}>Retry activation</button>
          </div>
        </div>
      ) : null}
      {step === 'setup' ? (
        <div className="flex flex-col gap-2" data-testid="wizard-setup">
          <p className="text-sm text-neutral-400">The local NNA service needs activation.</p>
          <button type="button" data-testid="wizard-activate" disabled={busy}
            className="w-fit rounded border border-white/15 px-3 py-1.5 text-xs text-neutral-200 hover:bg-white/10 disabled:opacity-50"
            onClick={() => void setup()}>Activate NNA</button>
        </div>
      ) : null}
      {busy ? <p className="mt-2 text-xs text-neutral-500" role="status" data-testid="wizard-busy">{busyText}</p> : null}
      {status !== null && step !== 'done' ? (
        <p className="mt-2 text-[11px] text-neutral-600" data-testid="wizard-status">
          service: {status.service_state} · configuration: {status.configuration_state} · execution: {status.execution_state}
        </p>
      ) : null}
    </div>
  );
}
