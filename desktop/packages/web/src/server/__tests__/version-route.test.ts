// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(`${tmpdir()}${sep}nnd-version-route-`);
process.env.NOTNATIVE_DATA_DIR = dataDir;

describe('public server compatibility route', () => {
  let app: { fetch: (request: Request) => Promise<Response> };

  beforeAll(async () => {
    const { createApp } = await import('../app.ts');
    const created = createApp();
    app = { fetch: async (request) => await created.fetch(request) };
  });

  afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

  it('answers unauthenticated version probes with the runtime URL compatibility contract', async () => {
    const response = await app.fetch(new Request('http://local/api/version'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json() as Record<string, unknown>;
    expect(body.status).toBe('ok');
    expect(typeof body.openchamberVersion).toBe('string');
    expect(['web', 'desktop']).toContain(body.runtime);
    expect(typeof body.startedAt).toBe('string');
    expect(body.compatibility).toEqual({
      apiVersion: 1,
      minClientApiVersion: 1,
      capabilities: ['api.runtime-url.v1'],
    });
    expect(body.serverId === null || typeof body.serverId === 'string').toBe(true);
  });
});
