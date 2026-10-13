// SPDX-License-Identifier: Apache-2.0
/**
 * Local speech module (W-114 TTS/STT leg): Windows SAPI via PowerShell
 * (-EncodedCommand, UTF-16LE base64 — no shell-quoting hazards). Everything
 * is local and free: System.Speech synthesis for TTS, System.Speech
 * recognition for STT. STT fails closed with a typed code when the local
 * recognizer is unavailable — the surface never fakes a transcript.
 */
import { spawn } from 'node:child_process';

export const MAX_SPEAK_CHARS = 2_000;
export const MAX_AUDIO_BYTES = 8_000_000;

export type SpeechVoice = { id: string; name: string; culture: string; gender: string };
export type SpeechRunner = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

function encoded(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

export function defaultRunner(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(args[0]!, args.slice(1), { windowsHide: true });
    const stdout: Buffer[] = []; const stderr: Buffer[] = []; let bytes = 0;
    child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.byteLength; if (bytes <= MAX_AUDIO_BYTES * 2) stdout.push(chunk); });
    child.stderr.on('data', (chunk: Buffer) => { bytes += chunk.byteLength; if (bytes <= MAX_AUDIO_BYTES * 2) stderr.push(chunk); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }));
  });
}

const TTS_SCRIPT = (text: string, rate: number, voice: string | null): string => `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
${voice ? `$s.SelectVoice('${voice}')` : ''}
$s.Rate = ${rate}
$s.Speak([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(text, 'utf8').toString('base64')}')))
`.trim();

const VOICES_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.GetInstalledVoices() | ForEach-Object { [PSCustomObject]@{ id = $_.VoiceInfo.Name; name = $_.VoiceInfo.Name; culture = $_.VoiceInfo.Culture.Name; gender = [string]$_.VoiceInfo.Gender } } | ConvertTo-Json -Compress
`.trim();

const STT_SCRIPT = (wavPath: string): string => `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine
$engine.LoadGrammar(New-Object System.Speech.Recognition.DictationGrammar)
$engine.SetInputToWaveFile('${wavPath}')
$try = $engine.Recognize()
if ($try -eq $null) { Write-Output '' } else { Write-Output $try.Text }
`.trim();

export async function listSpeechVoices(runner: SpeechRunner = defaultRunner): Promise<SpeechVoice[]> {
  const result = await runner(['powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(VOICES_SCRIPT)]);
  if (result.code !== 0) return [];
  const text = result.stdout.trim();
  if (!text) return [];
  const normalized = text.startsWith('[') ? text : `[${text.trim().split('\n').filter(Boolean).join(',')}]`;
  const parsed: unknown = JSON.parse(normalized);
  return (Array.isArray(parsed) ? parsed : [parsed]).flatMap((entry): SpeechVoice[] => {
    const voice = entry as Record<string, unknown>;
    return typeof voice.id === 'string' && typeof voice.name === 'string' && typeof voice.culture === 'string'
      ? [{ id: voice.id, name: voice.name, culture: voice.culture, gender: typeof voice.gender === 'string' ? voice.gender : 'NotSet' }]
      : [];
  });
}

export async function speakText(input: { text: string; rate?: number; voice?: string | null; runner?: SpeechRunner }): Promise<void> {
  const text = input.text.trim();
  if (!text || text.length > MAX_SPEAK_CHARS) throw new SpeechError('tts-invalid', 'Text must be 1..2000 characters.');
  const rate = Math.trunc(input.rate ?? 0);
  if (rate < -10 || rate > 10) throw new SpeechError('tts-invalid', 'Rate must be -10..10.');
  const voice = input.voice ? input.voice.replace(/'/gu, "''") : null;
  const result = await (input.runner ?? defaultRunner)(['powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(TTS_SCRIPT(text, rate, voice))]);
  if (result.code !== 0) throw new SpeechError('tts-failed', 'Local speech synthesis failed.');
}

/** Each speak run is a short-lived SAPI process; there is no long-lived
 * synth to stop. The endpoint exists for the surface and answers honestly. */
export async function stopSpeaking(): Promise<{ stopped: boolean; reason: string }> {
  return { stopped: false, reason: 'speech runs are short-lived processes; nothing to stop' };
}

export async function transcribeWav(input: { wavBase64: string; runner?: SpeechRunner; tmpPath: string }): Promise<string> {
  const bytes = Buffer.from(input.wavBase64, 'base64');
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_AUDIO_BYTES) throw new SpeechError('stt-invalid', 'Audio must be 1 byte..8 MB.');
  const { writeFile, unlink } = await import('node:fs/promises');
  await writeFile(input.tmpPath, bytes);
  try {
    const result = await (input.runner ?? defaultRunner)(['powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(STT_SCRIPT(input.tmpPath))]);
    if (result.code !== 0) throw new SpeechError('stt-local-unavailable', 'Local speech recognition is unavailable on this machine (fail-closed; no cloud fallback).');
    return result.stdout.trim();
  } finally {
    await unlink(input.tmpPath).catch(() => undefined);
  }
}

export class SpeechError extends Error {
  constructor(readonly code: 'tts-invalid' | 'tts-failed' | 'stt-invalid' | 'stt-local-unavailable', message: string) { super(message); }
}
