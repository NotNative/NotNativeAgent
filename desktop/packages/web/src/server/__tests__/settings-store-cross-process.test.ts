// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withConfigLock } from '../scheduled/config-lock.ts';

const scratch = mkdtempSync(join(tmpdir(), 'nnd-settings-xproc-'));
const prefs = join(scratch, 'preferences.json');
const previousDataDir = process.env.NOTNATIVE_DATA_DIR;
const moduleUrl = new URL('../lib/settings-store.ts', import.meta.url).href;
const childScript = [
  "import { writeFileSync } from 'node:fs';",
  'const store = await import(process.env.SETTINGS_MODULE);',
  // Signal only after module initialization, immediately before the locked
  // write, so the parent-held lock assertion observes real contenders.
  "writeFileSync(process.env.READY_FILE, 'ready');",
  "const patch = JSON.parse(process.env.PATCH);",
  "if (patch.publicOrigin) await store.recordPublicOriginIfUnset(patch.publicOrigin, () => true);",
  "else await store.writeSettingsPatchLocked(patch, 'web');",
  "writeFileSync(process.env.DONE_FILE, 'done');",
].join('\n');

beforeAll(() => { process.env.NOTNATIVE_DATA_DIR = scratch; });
afterAll(() => {
  if (previousDataDir === undefined) delete process.env.NOTNATIVE_DATA_DIR;
  else process.env.NOTNATIVE_DATA_DIR = previousDataDir;
  rmSync(scratch, { recursive: true, force: true });
});

function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolvePromise, reject) => {
    const poll = () => {
      try { readFileSync(path, 'utf8'); resolvePromise(); }
      catch {
        if (Date.now() >= deadline) reject(new Error(`child did not create ${path}`));
        else setTimeout(poll, 10);
      }
    };
    poll();
  });
}

function runWriter(key: string, value: unknown, id: string) {
  const ready = join(scratch, `${id}.ready`);
  const done = join(scratch, `${id}.done`);
  const child = spawn(process.execPath, ['--experimental-transform-types', '--input-type=module', '-e', childScript], {
    cwd: resolve(process.cwd(), '..', '..'),
    env: { ...process.env, NOTNATIVE_DATA_DIR: scratch, SETTINGS_MODULE: moduleUrl,
      PATCH: JSON.stringify({ [key]: value }), READY_FILE: ready, DONE_FILE: done },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  const exited = new Promise<void>((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolvePromise() : reject(new Error(`child exited ${code}: ${stderr}`)));
  });
  return { ready, done, exited };
}

describe('settings store cross-process writes', () => {
  it('serializes shared-file read/modify/write so parallel servers preserve both patches', async () => {
    const workers: ReturnType<typeof runWriter>[] = [];
    await withConfigLock(prefs, async () => {
      workers.push(runWriter('chatRenderMode', 'sorted', 'first'));
      workers.push(runWriter('fontSize', 123, 'second'));
      await Promise.all(workers.map((worker) => waitForFile(worker.ready)));
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      expect(workers.some((worker) => {
        try { readFileSync(worker.done, 'utf8'); return true; } catch { return false; }
      })).toBe(false);
    });
    await Promise.all(workers.map((worker) => worker.exited));
    const doc = JSON.parse(readFileSync(prefs, 'utf8')) as { fields: Record<string, { value?: unknown; surfaces?: Record<string, { value?: unknown }> }> };
    expect(doc.fields.chatRenderMode?.value).toBe('sorted');
    expect(doc.fields.fontSize?.surfaces?.web?.value).toBe(123);
  });
  it('keeps exactly one first registration origin across server processes and reloads', async () => {
    const first = runWriter('publicOrigin', 'https://first.example', 'origin-first');
    const second = runWriter('publicOrigin', 'https://second.example', 'origin-second');
    await Promise.all([first.exited, second.exited]);
    const canonical = JSON.parse(readFileSync(prefs, 'utf8')).fields.publicOrigin.value;
    expect(['https://first.example', 'https://second.example']).toContain(canonical);
    expect(JSON.parse(readFileSync(join(scratch, 'settings.json'), 'utf8')).publicOrigin).toBe(canonical);
    const store = await import('../lib/settings-store.ts');
    expect(store.readPublicOrigin()).toBe(canonical);
    expect(store.readMergedSettings('web').chatRenderMode).toBe('sorted');
  });
});
