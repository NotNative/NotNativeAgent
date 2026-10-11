// SPDX-License-Identifier: Apache-2.0
/**
 * Speech page (W-114): local TTS/STT surface over the SAPI-backed speech
 * routes. Honest availability: the STT row reports the local engine's
 * status and fails closed — no cloud fallback exists by contract.
 */
import { useCallback, useState, type ReactNode } from 'react';
import { runtimeFetch } from '../../../lib/runtime-fetch.ts';
import { getApiBaseUrl } from '../../../lib/runtime-url.ts';
import { SettingsGroupTitle } from '../primitives.tsx';

type Voice = { id: string; name: string; culture: string; gender: string };

export function SpeechPage(): ReactNode {
  const [voices, setVoices] = useState<Voice[] | null>(null);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [text, setText] = useState('');
  const [speakState, setSpeakState] = useState<'idle' | 'busy' | 'spoken' | 'failed'>('idle');
  const [sttState, setSttState] = useState<'idle' | 'busy' | 'ready' | 'unavailable'>('idle');
  const [sttText, setSttText] = useState<string | null>(null);

  const loadVoices = useCallback(async () => {
    setVoiceBusy(true);
    try {
      const response = await runtimeFetch(`${getApiBaseUrl()}/api/accessibility/speech/voices`, { signal: AbortSignal.timeout(15_000) });
      const body = (await response.json()) as { voices?: Voice[] };
      setVoices(body.voices ?? []);
    } catch { setVoices([]); }
    finally { setVoiceBusy(false); }
  }, []);

  const speak = useCallback(async () => {
    setSpeakState('busy');
    try {
      const response = await runtimeFetch(`${getApiBaseUrl()}/api/accessibility/speech/speak`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }), signal: AbortSignal.timeout(60_000),
      });
      setSpeakState(response.ok ? 'spoken' : 'failed');
    } catch { setSpeakState('failed'); }
  }, [text]);

  const probeStt = useCallback(async () => {
    setSttState('busy');
    // Availability probe: a silent 44-byte WAV header transcribes to '' when
    // the local engine is present; engine absence is a typed fail-closed.
    const silentWav = 'UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIhYAQACABAAZGF0YQAAAAA=';
    try {
      const response = await runtimeFetch(`${getApiBaseUrl()}/api/accessibility/speech/transcribe`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wavBase64: silentWav }), signal: AbortSignal.timeout(30_000),
      });
      const body = (await response.json()) as { text?: string; code?: string };
      if (typeof body.text === 'string') { setSttState('ready'); setSttText(body.text === '' ? null : body.text); }
      else setSttState('unavailable');
    } catch { setSttState('unavailable'); }
  }, []);

  return (
    <div className="space-y-4" data-testid="speech-page">
      <div>
        <SettingsGroupTitle>Text to speech (local)</SettingsGroupTitle>
        <p className="mb-2 text-xs text-muted-foreground">Speaks through the local SAPI voices on this machine. No cloud service is used.</p>
        <div className="flex gap-2">
          <input type="text" value={text} maxLength={2000} data-testid="speech-text"
            onChange={(event) => setText(event.target.value)}
            className="min-w-0 flex-1 rounded border border-border/60 bg-transparent px-2 py-1 text-xs" />
          <button type="button" data-testid="speech-speak" disabled={speakState === 'busy' || text.trim() === ''}
            className="rounded border border-border/60 px-2 py-1 text-xs disabled:opacity-40" onClick={() => void speak()}>Speak</button>
          <button type="button" data-testid="speech-voices" disabled={voiceBusy}
            className="rounded border border-border/60 px-2 py-1 text-xs disabled:opacity-40" onClick={() => void loadVoices()}>Voices</button>
        </div>
        {speakState === 'failed' ? <p className="mt-1 text-[11px] text-amber-300" role="alert" data-testid="speech-failure">Local speech synthesis failed on this machine.</p> : null}
        {speakState === 'spoken' ? <p className="mt-1 text-[11px] text-neutral-500" role="status" data-testid="speech-spoken">Spoken through the local synthesizer.</p> : null}
        {voices !== null ? (
          <ul className="mt-2 space-y-0.5" data-testid="speech-voice-list">
            {voices.map((voice) => <li key={voice.id} className="text-[11px] text-neutral-400">{voice.name} · {voice.culture} · {voice.gender}</li>)}
            {voices.length === 0 ? <li className="text-[11px] text-neutral-500">No local SAPI voices found.</li> : null}
          </ul>
        ) : null}
      </div>
      <div>
        <SettingsGroupTitle>Speech to text (local)</SettingsGroupTitle>
        <p className="mb-2 text-xs text-muted-foreground">Transcribes WAV audio through the local SAPI recognizer. When the local engine is absent the surface stays closed — no cloud fallback by contract.</p>
        <button type="button" data-testid="stt-probe" disabled={sttState === 'busy'}
          className="rounded border border-border/60 px-2 py-1 text-xs disabled:opacity-40" onClick={() => void probeStt()}>Check availability</button>
        {sttState === 'ready' ? <p className="mt-1 text-[11px] text-emerald-300" role="status" data-testid="stt-ready">Local recognizer available{sttText ? ` — sample: ${sttText}` : ' (silent sample transcribed empty)' }.</p> : null}
        {sttState === 'unavailable' ? <p className="mt-1 text-[11px] text-amber-300" role="alert" data-testid="stt-unavailable">Local speech recognition is unavailable on this machine (stt-local-unavailable).</p> : null}
      </div>
    </div>
  );
}
