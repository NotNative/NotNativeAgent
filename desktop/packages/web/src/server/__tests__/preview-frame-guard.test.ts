// SPDX-License-Identifier: Apache-2.0
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStaticHandler } from '../lib/static.ts';

const dist = mkdtempSync(join(tmpdir(), 'nnd-frame-guard-'));
writeFileSync(join(dist, 'index.html'), '<!doctype html><title>NND</title>');
writeFileSync(join(dist, 'asset.js'), 'export {}');
afterAll(() => rmSync(dist, { recursive: true, force: true }));

describe('NND UI frame guard', () => {
  const handle = createStaticHandler(dist);

  it('blocks the app shell from guest frames, including SPA fallback and HEAD', async () => {
    for (const [path, method] of [['/', 'GET'], ['/missing-route', 'GET'], ['/', 'HEAD']] as const) {
      const response = await handle(new Request(`http://localhost:3902${path}`, { method }));
      expect(response?.status).toBe(200);
      expect(response?.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
    }
  });

  it('does not add a framing policy to a non-document asset', async () => {
    const response = await handle(new Request('http://localhost:3902/asset.js'));
    expect(response?.headers.get('content-security-policy')).toBeNull();
  });
});
