// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WalkthroughCache } from '../lib/walkthrough/cache.ts';
import { sessionIdentity, walkthroughCacheKey } from '../lib/walkthrough/identity.ts';
import { sourceKey } from '../routes/git-walkthrough-sources.ts';
import { generateWalkthrough } from '../routes/git-walkthrough-generate.ts';
import { getWalkthroughSnapshot } from '../routes/git-walkthrough-snapshot.ts';

const json = (value: unknown, status = 200): Response => Response.json(value, { status });
const revision = 'b'.repeat(64);
const stop = { id: 'working:a.ts:12345678', scope: 'working' as const, path: 'a.ts', header: '@@ -1 +1 @@',
  oldStart: 1, newStart: 1, body: '-old\n+new' };
const snapshot = (): ReturnType<typeof getWalkthroughSnapshot> =>
  ({ signature: revision, stops: [stop], fileCount: 1, binaryFiles: 0 });
const modelAnswer = JSON.stringify({ chapters: [{ title: 'Behavior', stops: [{ alias: 'h1', explanation: 'The value changes.' }] }] });

describe('walkthrough durable cache', () => {
  it('reuses only exact source/model/language/capture identity and persists the result', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'nnd-walkthrough-')), 'walkthrough-cache.json');
    const cache = new WalkthroughCache(file);
    let calls = 0;
    let modelCalls = 0;
    const ports = { root: () => '/test-root', snapshot: () => snapshot(), call: async (request: Request) => {
      calls += 1;
      if (new URL(request.url).pathname.endsWith('/session/ses_test')) {
        return json({ directory: '/repo', model: { providerID: 'provider', id: 'model' } });
      }
      modelCalls += 1;
      return json({ revision, text: modelAnswer, providerID: 'provider', modelID: 'model' });
    } };
    await generateWalkthrough('/repo', 'ses_test', revision, ports, 'all', { cache, language: 'en' });
    expect(modelCalls).toBe(1);
    await cache.flush();

    const reloaded = new WalkthroughCache(file);
    const key = walkthroughCacheKey('walkthrough-cache-v1', '/test-root', sourceKey({ kind: 'working-tree', scope: 'all' }),
      sessionIdentity({ providerID: 'provider', modelID: 'model' }), 'en', snapshot());
    expect(reloaded.get(key)).not.toBeNull();
    expect(reloaded.size).toBe(1);
    const answer = await generateWalkthrough('/repo', 'ses_test', revision, ports, 'all',
      { cache: reloaded, language: 'en' }) as { chapters: { stops: { id: string; explanation: string }[] }[]; providerID: string };
    expect(calls).toBe(3);
    expect(answer).toMatchObject({ providerID: 'provider', modelID: 'model', revision,
      chapters: [{ stops: [{ id: stop.id, explanation: 'The value changes.' }] }] });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ version: 1 });
    expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')).entries)).toHaveLength(1);
  });

  it('does not reuse an entry when the capture signature changes with the same hunk IDs', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'nnd-walkthrough-')), 'walkthrough-cache.json');
    const cache = new WalkthroughCache(file);
    let modelCalls = 0;
    let captures = 0;
    const signatureAt = (draw: number): string => draw <= 2 ? `b${'b'.repeat(63)}` : `c${'b'.repeat(63)}`;
    const ports = { root: () => '/test-root', snapshot: () => {
      captures += 1;
      return { ...snapshot(), signature: signatureAt(captures) };
    }, call: async (request: Request) => {
      const signature = captures <= 2 ? `b${'b'.repeat(63)}` : `c${'b'.repeat(63)}`;
      if (new URL(request.url).pathname.endsWith('/session/ses_test')) {
        return json({ directory: '/repo', model: { providerID: 'provider', id: 'model' } });
      }
      modelCalls += 1;
      return json({ revision: signature, text: modelAnswer, providerID: 'provider', modelID: 'model' });
    } };
    await generateWalkthrough('/repo', 'ses_test', `b${'b'.repeat(63)}`, ports, 'all', { cache, language: 'en' });
    await generateWalkthrough('/repo', 'ses_test', `c${'b'.repeat(63)}`, ports, 'all', { cache, language: 'en' });
    expect(modelCalls).toBe(2);
  });
});
