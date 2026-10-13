// SPDX-License-Identifier: Apache-2.0
/**
 * W-114 local speech routes (TTS/STT): voices, speak, stop, transcribe.
 * All local (SAPI), fail-closed, no cloud fallback. Transcribe takes
 * base64 WAV ≤ 8 MB and writes it to a temp file outside any workspace.
 */
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { SpeechError, listSpeechVoices, speakText, stopSpeaking, transcribeWav } from '../lib/accessibility/speech.ts';

export function registerSpeechRoutes(app: Hono): void {
  app.get('/api/accessibility/speech/voices', (c) => (async () => {
    try { return c.json({ voices: await listSpeechVoices() }); }
    catch { return c.json({ error: 'Voice enumeration failed.', code: 'tts-failed' }, 500); }
  })());

  app.post('/api/accessibility/speech/speak', (c) => (async () => {
    const body = await c.req.json().catch(() => null) as { text?: unknown; rate?: unknown; voice?: unknown } | null;
    try {
      await speakText({
        text: typeof body?.text === 'string' ? body.text : '',
        rate: typeof body?.rate === 'number' ? body.rate : 0,
        voice: typeof body?.voice === 'string' ? body.voice : null,
      });
      return c.json({ spoken: true });
    } catch (cause) {
      if (cause instanceof SpeechError) return c.json({ error: cause.message, code: cause.code }, cause.code === 'tts-invalid' ? 400 : 500);
      return c.json({ error: 'Speech synthesis failed.', code: 'tts-failed' }, 500);
    }
  })());

  app.post('/api/accessibility/speech/stop', (c) => (async () => c.json(await stopSpeaking()))());

  app.post('/api/accessibility/speech/transcribe', (c) => (async () => {
    const body = await c.req.json().catch(() => null) as { wavBase64?: unknown } | null;
    try {
      const text = await transcribeWav({
        wavBase64: typeof body?.wavBase64 === 'string' ? body.wavBase64 : '',
        tmpPath: joinPath(tmpdir(), `nnd-stt-${randomUUID()}.wav`),
      });
      return c.json({ text });
    } catch (cause) {
      if (cause instanceof SpeechError) return c.json({ error: cause.message, code: cause.code }, cause.code === 'stt-invalid' ? 400 : 409);
      return c.json({ error: 'Transcription failed.', code: 'stt-local-unavailable' }, 409);
    }
  })());
}
