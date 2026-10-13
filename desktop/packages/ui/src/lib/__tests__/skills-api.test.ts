// SPDX-License-Identifier: Apache-2.0
/** Transport pin for the NND skills catalog client. */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const globalScope = globalThis as { fetch?: typeof fetch };
  const previous = globalScope.fetch;
  const native = vi.fn<(input: RequestInfo, init?: RequestInit) => Promise<Response>>();
  globalScope.fetch = native as unknown as typeof fetch;
  return { native, previous };
});

import {
  installSkills, loadSkillCatalog, loadSkillCatalogSource, listSkills, scanSkills, SkillApiError,
} from '../skills-api.ts';
import { configureRuntimeUrlResolver } from '../runtime-url.ts';

const native = hoisted.native;

afterAll(() => {
  (globalThis as { fetch?: unknown }).fetch = hoisted.previous;
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

afterEach(() => { native.mockReset(); });

describe('skills catalog API transport', () => {
  configureRuntimeUrlResolver({ apiBaseUrl: 'http://skills.test' });

  it('uses the documented catalog and list endpoints', async () => {
    native.mockResolvedValueOnce(json(200, { ok: true, sources: [], itemsBySource: {} }));
    native.mockResolvedValueOnce(json(200, { skills: [], externalSkills: {} }));
    await loadSkillCatalog();
    await listSkills('D:/repo');
    expect(native.mock.calls[0]![0]).toBe('http://skills.test/api/config/skills/catalog');
    expect(native.mock.calls[1]![0]).toBe('http://skills.test/api/config/skills?directory=D%3A%2Frepo');
  });

  it('passes source selection, refresh, and installed-state enrichment', async () => {
    native.mockResolvedValueOnce(json(200, { ok: true, source: {}, sourceId: 'anthropic', items: [] }));
    const result = await loadSkillCatalogSource('anthropic', { directory: 'D:/repo x', refresh: true });
    expect(result).toEqual({ ok: true, source: {}, sourceId: 'anthropic', items: [] });
    expect(native.mock.calls[0]![0]).toBe('http://skills.test/api/config/skills/catalog/source?sourceId=anthropic&refresh=true&directory=D%3A%2Frepo+x');
  });

  it('sends bounded scan and install payloads', async () => {
    native.mockResolvedValueOnce(json(200, { ok: true, items: [] }));
    await scanSkills({ source: 'example/skills', subpath: 'skills', gitIdentityId: null });
    expect(native.mock.calls[0]![1]).toMatchObject({ method: 'POST' });
    expect(native.mock.calls[0]![1]?.body).toBe(JSON.stringify({
      source: 'example/skills', subpath: 'skills', gitIdentityId: null,
    }));

    native.mockResolvedValueOnce(json(200, {
      ok: true, installed: [], skipped: [], requiresReload: true, message: 'done',
    }));
    await installSkills({
      source: 'example/skills', scope: 'project', selections: ['demo-flow'], conflictPolicy: 'overwriteAll',
    }, 'D:/repo');
    expect(native.mock.calls[1]![0]).toBe('http://skills.test/api/config/skills/install?directory=D%3A%2Frepo');
    expect(native.mock.calls[1]![1]).toMatchObject({ method: 'POST' });
  });

  it('preserves structured catalog failures and conflict payloads', async () => {
    native.mockResolvedValueOnce(json(401, { error: { kind: 'authRequired', message: 'Authentication required', identities: [] } }));
    await expect(loadSkillCatalogSource('anthropic')).rejects.toMatchObject({
      status: 401, kind: 'authRequired', message: 'Authentication required',
    } satisfies Partial<SkillApiError>);

    native.mockResolvedValueOnce(json(401, {
      error: { kind: 'authRequired', message: 'Authentication required',
        identities: [null, { id: 'work-key', name: 'Work' }, { id: ' ', name: 'Bad' }] },
    }));
    await expect(loadSkillCatalogSource('anthropic')).rejects.toMatchObject({
      status: 401, kind: 'authRequired', identities: [{ id: 'work-key', name: 'Work' }],
    } satisfies Partial<SkillApiError>);

    native.mockResolvedValueOnce(json(409, {
      error: {
        kind: 'conflicts', message: 'skills already exist',
        conflicts: [{ skillName: 'demo-flow', path: 'D:/repo/demo-flow', scope: 'user', source: 'agents' }],
      },
    }));
    const conflict = installSkills({
      source: 'demo', scope: 'user', selections: ['demo-flow'], conflictPolicy: 'prompt',
    });
    await expect(conflict).rejects.toMatchObject({
      kind: 'conflicts', status: 409, conflicts: [{
        skillName: 'demo-flow', path: 'D:/repo/demo-flow', scope: 'user', source: 'agents',
      }],
    } satisfies Partial<SkillApiError>);
  });

  it('forwards an install abort signal without coalescing', async () => {
    native.mockResolvedValueOnce(json(200, { ok: true, installed: [], skipped: [], requiresReload: true, message: 'done' }));
    const signal = new AbortController().signal;
    await installSkills({ source: 'demo', scope: 'user', selections: ['demo-flow'] }, 'D:/repo', { signal });
    expect(native.mock.calls[0]![1]).toMatchObject({ method: 'POST', signal });
  });
  it('requires a directory for project installs and rejects source-id injection', () => {
    expect(() => installSkills({
      source: 'demo', scope: 'project', selections: ['demo'],
    })).toThrow(/Project checkout directory is required/u);
    expect(() => loadSkillCatalogSource('bad/path you')).toThrow(/Invalid source ID/u);
  });
});
