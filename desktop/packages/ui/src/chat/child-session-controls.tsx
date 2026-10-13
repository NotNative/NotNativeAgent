// SPDX-License-Identifier: Apache-2.0
/** Child transcripts stay read-only until NNA grants a live steering action. */
import { useEffect, useState, type ReactNode } from 'react';
import { ascendingId, harnessClient } from '../lib/nnd/client.ts';
import { steeringAllowed, steeringKey, subscribeSteering } from '../lib/nnd/steering-capability.ts';

const CAPABILITY_POLL_MS = 3_000;
const MAX_STEER_CHARS = 4_000;

export function ChildSessionControls({ sessionID, directory }: { sessionID: string; directory: string }): ReactNode {
  // The reconnect resync refreshes the shared snapshot; a remount after a
  // stream gap starts from it instead of a blind reset, and the subscription
  // flips the button the moment a reconnect-time refresh lands.
  const [granted, setGranted] = useState(() => steeringAllowed(sessionID, directory));
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState('');
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState('');

  useEffect(() => subscribeSteering((key) => {
    if (key === steeringKey(sessionID, directory)) setGranted(steeringAllowed(sessionID, directory));
  }), [sessionID, directory]);

  useEffect(() => {
    let current = true;
    let fetching = false;
    setGranted(steeringAllowed(sessionID, directory));
    setOpen(false);
    setContent('');
    setPending(false);
    setNotice('');
    const refresh = async (): Promise<void> => {
      if (fetching) return;
      fetching = true;
      try {
        const result = await harnessClient.childSteeringCapability(sessionID, { directory });
        if (!current) return;
        const allowed = !result.error && result.data?.session_id === sessionID
          && result.data.capabilities?.steer_subagent === true && result.data.availability === 'granted';
        setGranted(Boolean(allowed));
        if (!allowed) setOpen(false);
      } catch {
        if (current) { setGranted(false); setOpen(false); }
      } finally { fetching = false; }
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, CAPABILITY_POLL_MS);
    return () => { current = false; clearInterval(timer); };
  }, [sessionID, directory]);

  const send = async (): Promise<void> => {
    const text = content.trim();
    if (!granted || pending || !text || text.length > MAX_STEER_CHARS) return;
    setPending(true);
    setNotice('');
    try {
      // Security: the initial grant is only a display hint. Recheck immediately
      // before submission; NNA remains the owner of the final steering decision.
      const capability = await harnessClient.childSteeringCapability(sessionID, { directory });
      if (capability.error || capability.data?.session_id !== sessionID
        || capability.data.capabilities?.steer_subagent !== true || capability.data.availability !== 'granted') {
        setGranted(false);
        setOpen(false);
        setNotice('Steering is no longer available for this subagent.');
        return;
      }
      const result = await harnessClient.steerChildSession(sessionID, { request_id: ascendingId('nnd_steer'), content: text }, { directory });
      if (result.error || result.data?.accepted !== true) {
        setNotice('Steering could not be confirmed. Check the transcript before trying again.');
        return;
      }
      setContent('');
      setOpen(false);
      setNotice('Steering sent to the subagent.');
    } catch {
      setNotice('Steering could not be confirmed. Check the transcript before trying again.');
    } finally { setPending(false); }
  };

  return <div data-testid="subagent-controls" className="text-xs text-neutral-500">
    <span>Subagent transcript is read-only by default.</span>
    {granted ? <button type="button" className="ml-2 rounded border border-white/15 px-2 py-1 text-neutral-300 hover:border-white/30"
      aria-expanded={open} aria-controls="subagent-steering-form" onClick={() => setOpen((value) => !value)}>Steer subagent</button> : null}
    {open && granted ? <div id="subagent-steering-form" className="mt-2 flex flex-col gap-2">
      <label htmlFor="subagent-steering-text" className="text-neutral-400">Message to subagent</label>
      <textarea id="subagent-steering-text" value={content} maxLength={MAX_STEER_CHARS} rows={3}
        onChange={(event) => setContent(event.target.value)} className="rounded border border-white/15 bg-neutral-900 p-2 text-neutral-100"
        disabled={pending} />
      <div><button type="button" onClick={() => { void send(); }} disabled={pending || !content.trim()}
        className="rounded border border-white/15 px-2 py-1 text-neutral-200 disabled:opacity-40">{pending ? 'Sending…' : 'Send steering'}</button></div>
    </div> : null}
    {notice ? <p role="status" className="mt-2 text-neutral-400">{notice}</p> : null}
  </div>;
}
