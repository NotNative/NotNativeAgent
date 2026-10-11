// SPDX-License-Identifier: Apache-2.0
/** W-114 speech module: command construction, parsing, fail-closed codes. */
import { describe, expect, it } from 'vitest';
import { listSpeechVoices, speakText, stopSpeaking, transcribeWav, SpeechError } from '../lib/accessibility/speech.ts';

function decode(command: string): string {
  return Buffer.from(command, 'base64').toString('utf16le');
}

function runnerFrom(scripts: Record<string, { code: number; stdout: string; stderr: string }>) {
  return async (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
    const script = decode(args.find(arg => arg.length > 40) ?? '');
    for (const [needle, response] of Object.entries(scripts)) {
      if (script.includes(needle)) return response;
    }
    return { code: 1, stdout: '', stderr: 'not matched' };
  };
}

const wavScript = 'SetInputToWaveFile';

describe('local speech module (W-114)', () => {
  it('enumerates voices from the local SAPI catalog (single + list shapes)', async () => {
    const one = await listSpeechVoices(runnerFrom({ GetInstalledVoices: { code: 0, stdout: '{"id":"Zira","name":"Microsoft Zira","culture":"en-US","gender":"Female"}\n', stderr: '' } }));
    expect(one).toEqual([{ id: 'Zira', name: 'Microsoft Zira', culture: 'en-US', gender: 'Female' }]);
    const many = await listSpeechVoices(runnerFrom({ GetInstalledVoices: { code: 0, stdout: '{"id":"A","name":"A Voice","culture":"en-US"}\n{"id":"B","name":"B Voice","culture":"de-DE"}\n', stderr: '' } }));
    expect(many.map(v => v.id)).toEqual(['A', 'B']);
    const none = await listSpeechVoices(runnerFrom({ GetInstalledVoices: { code: 1, stdout: '', stderr: 'boom' } }));
    expect(none).toEqual([]); // enumeration fails soft
  });

  it('speak bounds text and rate, escapes the voice, embeds UTF-8 text base64', async () => {
    const seen: string[] = [];
    const runner = async (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
      seen.push(decode(args.find(arg => arg.length > 40) ?? ''));
      return { code: 0, stdout: '', stderr: '' };
    };
    await speakText({ text: 'Hello operator', rate: 2, voice: "Hazel O'Brien", runner });
    expect(seen[0]).toContain("$s.Rate = 2");
    expect(seen[0]).toContain("SelectVoice('Hazel O''Brien')");
    expect(seen[0]).toContain(Buffer.from('Hello operator', 'utf8').toString('base64'));
    await expect(speakText({ text: '', runner })).rejects.toMatchObject({ code: 'tts-invalid' });
    await expect(speakText({ text: 'x'.repeat(2001), runner })).rejects.toMatchObject({ code: 'tts-invalid' });
    await expect(speakText({ text: 'hi', rate: 11, runner })).rejects.toMatchObject({ code: 'tts-invalid' });
    await expect(speakText({ text: 'hi', runner: runnerFrom({ Speak: { code: 1, stdout: '', stderr: 'no audio device' } }) }))
      .rejects.toMatchObject({ code: 'tts-failed' });
  });

  it('stop is an honest no-op (short-lived SAPI runs)', async () => {
    await expect(stopSpeaking()).resolves.toMatchObject({ stopped: false, reason: expect.stringContaining('short-lived') });
  });

  it('transcribe writes bounded WAV, returns the local transcript, fails closed unavailable', async () => {
    const writes: string[] = [];
    const runner = async (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
      const script = decode(args.find(arg => arg.length > 40) ?? '');
      writes.push(script);
      return { code: 0, stdout: 'recognized words\n', stderr: '' };
    };
    const text = await transcribeWav({ wavBase64: Buffer.from('RIFF-fake').toString('base64'), runner, tmpPath: 'unused-path' });
    expect(text).toBe('recognized words');
    expect(writes[0]).toContain(wavScript);
    await expect(transcribeWav({ wavBase64: '', runner, tmpPath: 'p' })).rejects.toMatchObject({ code: 'stt-invalid' });
    await expect(transcribeWav({ wavBase64: Buffer.alloc(9_000_000).toString('base64'), runner, tmpPath: 'p' }))
      .rejects.toMatchObject({ code: 'stt-invalid' });
    const unavailable = runnerFrom({ SetInputToWaveFile: { code: 1, stdout: '', stderr: 'no recognizer' } });
    await expect(transcribeWav({ wavBase64: Buffer.from('RIFF').toString('base64'), runner: unavailable, tmpPath: 'p' }))
      .rejects.toMatchObject({ code: 'stt-local-unavailable' });
    expect(new SpeechError('tts-failed', 'x')).toBeInstanceOf(Error);
  });
});
