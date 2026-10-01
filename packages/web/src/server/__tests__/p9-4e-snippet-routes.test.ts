// SPDX-License-Identifier: Apache-2.0
/** P9-4e-i snippet config-entity routes (doc 03 §5.x "Snippets"): the
 * list/create/read/patch/delete family over a real `<config>/snippets`
 * store in a temp data dir, the doc-verbatim error strings (409 exists,
 * 404 not found, the name-pattern 400), expansion keep-unknown semantics,
 * and the reserved `expand` word that must never shadow the expansion
 * route (Hono first-match order). */
import { describe, expect, it, afterAll, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as joinPath, sep } from 'node:path';
import { Hono } from 'hono';

const ROOT = mkdtempSync(`${tmpdir()}${sep}nnd-p94e-snippets-`);
process.env.NOTNATIVE_DATA_DIR = ROOT;

/** The unlink seam: pass-through by default; the lost-race pin rejects it
 * deterministically to exercise the ENOENT fold without a scheduler race. */
const { unlinkMock } = vi.hoisted(() => ({ unlinkMock: vi.fn() }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const real = actual.unlink.bind(actual);
  unlinkMock.mockImplementation((...args: Parameters<typeof actual.unlink>) => real(...args));
  return { ...actual, unlink: unlinkMock as unknown as typeof actual.unlink };
});

const { registerSnippetRoutes } = await import('../routes/snippets.ts');
const { snippetsDirFor, deleteSnippet } = await import('../snippets/snippet-store.ts');

const app = new Hono();
registerSnippetRoutes(app);

const call = async (path: string, init?: RequestInit): Promise<Response> =>
  app.fetch(new Request(`http://t.test${path}`, {
    headers: { 'content-type': 'application/json' }, ...init,
  })) as Promise<Response>;

const post = (path: string, body: unknown): Promise<Response> =>
  call(path, { method: 'POST', body: JSON.stringify(body) });

afterEach(() => { unlinkMock.mockClear(); });
afterAll(() => { rmSync(ROOT, { recursive: true, force: true }); });

describe('snippet config-entity routes (P9-4e-i)', () => {
  it('list on a fresh store answers {snippets: []}', async () => {
    const response = await call('/api/config/snippets');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ snippets: [] });
  });

  it('create answers success+snippet with the global default; read+list roundtrip sorted', async () => {
    const first = await post('/api/config/snippets/zeta', { text: 'z-body' });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      success: true, snippet: { name: 'zeta', text: 'z-body', scope: 'global' },
    });
    await post('/api/config/snippets/alpha', { text: 'a-body', scope: 'project' });
    const record = await (await call('/api/config/snippets/zeta')).json();
    expect(record).toEqual({ name: 'zeta', text: 'z-body', scope: 'global' });
    const list = await (await call('/api/config/snippets')).json() as { snippets: { name: string }[] };
    expect(list.snippets.map((entry) => entry.name)).toEqual(['alpha', 'zeta']);
    const stored = JSON.parse(readFileSync(joinPath(snippetsDirFor(), 'zeta.json'), 'utf8'));
    expect(stored).toEqual({ name: 'zeta', text: 'z-body', scope: 'global' });
  });

  it('create duplicate answers 409 with the registered string', async () => {
    const response = await post('/api/config/snippets/zeta', { text: 'again' });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'snippet exists' });
  });

  it('the reserved expand word never shadows the expansion route and never creates', async () => {
    const response = await post('/api/config/snippets/expand', { text: 'x #alpha y' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: 'x a-body y' });
    const gone = await call('/api/config/snippets/expand');
    expect(gone.status).toBe(404);
  });

  it('patch merges over the stored record; the route name is the authority', async () => {
    const merged = await (await call('/api/config/snippets/alpha', {
      method: 'PATCH', body: JSON.stringify({ text: 'a-body-2', name: 'sneaky' }),
    })).json();
    expect(merged).toEqual({ success: true, snippet: { name: 'alpha', text: 'a-body-2', scope: 'project' } });
    const emptied = await post('/api/config/snippets/beta', { text: 'b', scope: 7 });
    expect(emptied.status).toBe(400);
    expect(await emptied.json()).toEqual({ error: 'snippet scope must be a string' });
    const missing = await call('/api/config/snippets/missing', {
      method: 'PATCH', body: JSON.stringify({ text: 'x' }),
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'snippet not found' });
  });

  it('delete round-trips and answers 404 afterwards', async () => {
    const removed = await call('/api/config/snippets/beta', { method: 'DELETE' });
    expect(removed.status).toBe(404); // the 400 above means beta never landed
    const gone = await call('/api/config/snippets/zeta', { method: 'DELETE' });
    expect(gone.status).toBe(200);
    expect(await gone.json()).toEqual({ success: true });
    const second = await call('/api/config/snippets/zeta', { method: 'DELETE' });
    expect(second.status).toBe(404);
    expect(await second.json()).toEqual({ error: 'snippet not found' });
  });

  it('expand keeps unknown tokens and replaces known ones; bodies validate', async () => {
    await post('/api/config/snippets/sig', { text: 'sig-text' });
    const expanded = await (await post('/api/config/snippets/expand', {
      text: 'x #sig y #nope #sig',
    })).json();
    expect(expanded).toEqual({ text: 'x sig-text y #nope sig-text' });
    const badText = await post('/api/config/snippets/expand', { text: 5 });
    expect(badText.status).toBe(400);
    expect(await badText.json()).toEqual({ error: 'expand text must be a string' });
    const badBody = await call('/api/config/snippets/expand', { method: 'POST', body: '{oops' });
    expect(badBody.status).toBe(400);
    expect(await badBody.json()).toEqual({ error: 'expand body must be a JSON object' });
  });

  it('bodies validate on create: text required, non-empty', async () => {
    const noText = await post('/api/config/snippets/gamma', { scope: 'global' });
    expect(noText.status).toBe(400);
    expect(await noText.json()).toEqual({ error: 'snippet text must be a string' });
    const empty = await post('/api/config/snippets/gamma', { text: '' });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ error: 'snippet text must not be empty' });
    const badBody = await call('/api/config/snippets/gamma', { method: 'POST', body: 'null' });
    expect(badBody.status).toBe(400);
    expect(await badBody.json()).toEqual({ error: 'snippet body must be a JSON object' });
  });

  it('names outside [\\w-]{1,64} answer 400 across the family', async () => {
    for (const [method, path] of [
      ['GET', '/api/config/snippets/bad.name'],
      ['POST', '/api/config/snippets/bad.name'],
      ['PATCH', '/api/config/snippets/bad.name'],
      ['DELETE', '/api/config/snippets/bad.name'],
    ] as const) {
      const response = await call(path, { method, body: method === 'GET' ? undefined : JSON.stringify({ text: 'x' }) });
      expect(response.status, `${method} ${path}`).toBe(400);
      expect(await response.json()).toEqual({ error: 'snippet name must match [\\w-]{1,64}' });
    }
  });

  it('malformed stored files are skipped by the list, not fatal', async () => {
    writeFileSync(joinPath(snippetsDirFor(), 'corrupt.json'), '{oops', 'utf8');
    const list = await (await call('/api/config/snippets')).json() as { snippets: { name: string }[] };
    expect(list.snippets.map((entry) => entry.name)).toEqual(['alpha', 'sig']);
  });

  it('the dataDir option injects an isolated store', async () => {
    const isolated = new Hono();
    const elsewhere = mkdtempSync(`${tmpdir()}${sep}nnd-p94e-elsewhere-`);
    registerSnippetRoutes(isolated, { dataDir: elsewhere });
    const created = await isolated.fetch(new Request('http://t.test/api/config/snippets/iso', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'iso' }),
    }));
    expect(created.status).toBe(200);
    const envList = await (await call('/api/config/snippets')).json() as { snippets: { name: string }[] };
    expect(envList.snippets.map((entry) => entry.name)).not.toContain('iso');
    const isoList = await (await isolated.fetch(new Request('http://t.test/api/config/snippets'))).json() as { snippets: { name: string }[] };
    expect(isoList.snippets.map((entry) => entry.name)).toEqual(['iso']);
    rmSync(elsewhere, { recursive: true, force: true });
  });
});

describe('P9-4e-i audit pins (reserved names, traversal, races, enlargement parity)', () => {
  /** An isolated route instance so reserved stores never pollute the shared
   * fixture data dir. */
  function isolatedStore(): { app: Hono; dir: string; cleanup: () => void } {
    const dir = mkdtempSync(`${tmpdir()}${sep}nnd-p94e-reserved-`);
    const app = new Hono();
    registerSnippetRoutes(app, { dataDir: dir });
    return {
      app, dir,
      cleanup: () => { rmSync(dir, { recursive: true, force: true }); },
    };
  }

  const reservedCall = (store: { app: Hono }, path: string, init?: RequestInit): Promise<Response> =>
    store.app.fetch(new Request(`http://t.test${path}`, {
      headers: { 'content-type': 'application/json' }, ...init,
    })) as Promise<Response>;

  it('Windows-reserved device names answer 400 and never touch the store', async () => {
    const store = isolatedStore();
    try {
      // Raw premise (probed): THIS Windows build allows writing aux.json, so
      // the defect is NOT an unhandled 500 today - it is a name that silently
      // succeeds here yet deterministically fails (unhandled throw -> 500) on
      // platforms that refuse device names. The registered answer is the
      // platform-independent 400, for the family, before ANY write attempt.
      for (const name of ['aux', 'con', 'nul', 'prn', 'com1', 'com9', 'lpt1', 'lpt9', 'AUX']) {
        const response = await reservedCall(store, `/api/config/snippets/${name}`, {
          method: 'POST', body: JSON.stringify({ text: 'x' }),
        });
        expect(response.status, `POST ${name}`).toBe(400);
        expect(await response.json()).toEqual({ error: 'snippet name is reserved on this platform' });
        expect(existsSync(joinPath(store.dir, 'config', 'snippets', `${name}.json`)), name).toBe(false);
      }
      for (const [method, name] of [['GET', 'aux'], ['PATCH', 'aux'], ['DELETE', 'con']] as const) {
        const response = await reservedCall(store, `/api/config/snippets/${name}`, {
          method, body: method === 'PATCH' ? JSON.stringify({ text: 'x' }) : undefined,
        });
        expect(response.status, `${method} ${name}`).toBe(400);
        expect(await response.json()).toEqual({ error: 'snippet name is reserved on this platform' });
      }
    } finally { store.cleanup(); }
  });

  it('URL-decoded traversal names never write outside the snippets dir', async () => {
    const store = isolatedStore();
    try {
      // '%2e%2e%2f' decodes to '../' - Hono delivers the DECODED param, and
      // the pattern guard must refuse before any read/write path.
      for (const encoded of ['..%2fescape', '%2E%2E%2Fescape', 'a%23b', 'snip%252F']) {
        const response = await reservedCall(store, `/api/config/snippets/${encoded}`, {
          method: 'POST', body: JSON.stringify({ text: 'x' }),
        });
        expect(response.status, encoded).toBe(400);
        expect(await response.json()).toEqual({ error: 'snippet name must match [\\w-]{1,64}' });
      }
      expect(existsSync(joinPath(store.dir, 'escape.json'))).toBe(false);
      expect(existsSync(joinPath(store.dir, 'config', 'snippets', 'escape.json'))).toBe(false);
      const fetched = await reservedCall(store, '/api/config/snippets/%2e%2e%2fescape');
      expect(fetched.status).toBe(400);
      expect(await fetched.json()).toEqual({ error: 'snippet name must match [\\w-]{1,64}' });
    } finally { store.cleanup(); }
  });

  it('concurrent double DELETE has one winner even when Windows unlinks both requests successfully', async () => {
    await post('/api/config/snippets/racy', { text: 'racy body' });
    const realUnlink = unlinkMock.getMockImplementation()!;
    let entered!: () => void;
    let release!: () => void;
    const unlinkEntered = new Promise<void>((resolve) => { entered = resolve; });
    const firstUnlinkHeld = new Promise<void>((resolve) => { release = resolve; });
    unlinkMock.mockImplementationOnce(async (...args: Parameters<typeof unlinkMock>) => {
      entered();
      await firstUnlinkHeld;
      return realUnlink(...args);
    });
    // If the second call reaches unlink, model Windows accepting another
    // unlink while the first deletion is pending. The file lock must keep it
    // from claiming a second successful DELETE.
    unlinkMock.mockImplementationOnce(async () => undefined);
    const first = deleteSnippet('racy');
    await unlinkEntered;
    // Calling the store operation directly avoids route-level async lookup
    // timing; without arbitration both calls reach unlink while the first is
    // held, deterministically exercising Windows' duplicate-success case.
    const second = deleteSnippet('racy');
    release();
    const responses = await Promise.all([first, second]);
    // Both one-shot behaviors are scoped to this simulated contention.
    unlinkMock.mockReset();
    unlinkMock.mockImplementation(realUnlink);
    // Simulate Windows' successful pending-delete behavior deterministically:
    // once the first request owns the file lock and removes it, the second
    // observes absence instead of reporting a second successful deletion.
    expect(responses.sort()).toEqual([false, true]);
  });

  it('the EPERM fold: a gone-by-probe race folds to the 404 arm; an open window retries', async () => {
    await post('/api/config/snippets/epvin', { text: 'raced body' });
    const target = joinPath(snippetsDirFor(), 'epvin.json');
    const violation = (): Error => Object.assign(new Error('sharing violation'), { code: 'EPERM' });
    // (a) the winner already finished: probe sees gone -> fold false (404 class)
    unlinkMock.mockImplementationOnce(async () => { rmSync(target); throw violation(); });
    await expect(deleteSnippet('epvin')).resolves.toBe(false);
    // (b) the window is still open: probe sees present -> retry ticks the real unlink
    await post('/api/config/snippets/epvin2', { text: 'raced again' });
    const target2 = joinPath(snippetsDirFor(), 'epvin2.json');
    unlinkMock.mockImplementationOnce(async () => { throw violation(); });
    await expect(deleteSnippet('epvin2')).resolves.toBe(true);
    expect(existsSync(target2)).toBe(false);
  });

  it('a stubborn EPERM with the file still present rethrows (the 500 class)', async () => {
    await post('/api/config/snippets/stuck', { text: 'stuck body' });
    const violation = (): Error => Object.assign(new Error('sharing violation'), { code: 'EPERM' });
    unlinkMock.mockImplementationOnce(async () => { throw violation(); });
    unlinkMock.mockImplementationOnce(async () => { throw violation(); });
    await expect(deleteSnippet('stuck')).rejects.toMatchObject({ code: 'EPERM' });
  });

  it('PATCH text:null folds to the registered string-must 400 (null is not absent)', async () => {
    await post('/api/config/snippets/nullish', { text: 'keep me' });
    const patched = await call('/api/config/snippets/nullish', {
      method: 'PATCH', body: JSON.stringify({ text: null }),
    });
    expect(patched.status).toBe(400);
    expect(await patched.json()).toEqual({ error: 'snippet text must be a string' });
    const still = await (await call('/api/config/snippets/nullish')).json();
    expect(still).toEqual({ name: 'nullish', text: 'keep me', scope: 'global' }); // 400 leaves the record intact
  });

  it('route expansion is byte-identical with the composer submit-time rule', async () => {
    await post('/api/config/snippets/sig-x', { text: 'sig-x-body' });
    // The roster the composer's send-planner would expand over is the SAME
    // list the route answers; the expected text is derived from it with an
    // independently spelled preamble of the same #([A-Za-z0-9_-]+) rule.
    const list = await (await call('/api/config/snippets')).json() as { snippets: { name: string; text: string }[] };
    const roster = new Map(list.snippets.map((entry) => [entry.name, entry.text] as const));
    const input = 'a #sig.x b #sig-x c #Sig d #nope';
    const expected = input.replace(/#([A-Za-z0-9_-]+)/gu, (whole, name: string) => roster.get(name) ?? whole);
    const expanded = await (await post('/api/config/snippets/expand', { text: input })).json();
    expect(expanded).toEqual({ text: expected });
    expect(expected).toBe('a sig-text.x b sig-x-body c #Sig d #nope'); // dot splits the match; case keys exact
  });

  it('a case-variant name folds on the volume: 409 create, the stored case answers lookups', async () => {
    await post('/api/config/snippets/folder', { text: 'folded body', scope: 'proj' });
    const recased = await post('/api/config/snippets/FOLDER', { text: 'hijack attempt' });
    expect(recased.status).toBe(409); // the volume IS the namespace on this platform
    expect(await recased.json()).toEqual({ error: 'snippet exists' });
    const read = await (await call('/api/config/snippets/FOLDER')).json();
    expect(read).toEqual({ name: 'folder', text: 'folded body', scope: 'proj' }); // the STORED case answers
    const patched = await call('/api/config/snippets/FOLDER', {
      method: 'PATCH', body: JSON.stringify({ text: 'v2' }),
    });
    expect(await patched.json()).toEqual({ success: true, snippet: { name: 'folder', text: 'v2', scope: 'proj' } });
    // existsSync would fold the case; assert the VOLUME's entry spellings.
    const entries = await readdir(snippetsDirFor());
    expect(entries.includes('FOLDER.json')).toBe(false); // no retitle by the URL's case
    expect(entries.includes('folder.json')).toBe(true);
    const still = await (await call('/api/config/snippets/folder')).json();
    expect(still).toEqual({ name: 'folder', text: 'v2', scope: 'proj' });
    const deleted = await call('/api/config/snippets/FOLDER', { method: 'DELETE' });
    expect(deleted.status).toBe(200); // resolution drives deletes too
  });

  it('a lost-race unlink ENOENT folds to false; real faults still throw', async () => {
    await post('/api/config/snippets/gone-fast', { text: 'pending vanish' });
    unlinkMock.mockRejectedValueOnce(Object.assign(new Error('vanished'), { code: 'ENOENT' }));
    const lost = await deleteSnippet('gone-fast');
    expect(lost).toBe(false); // the concurrent DELETE already removed it: 404, not 500
    unlinkMock.mockRejectedValueOnce(Object.assign(new Error('sticky'), { code: 'EBUSY' }));
    await expect(deleteSnippet('gone-fast')).rejects.toMatchObject({ code: 'EBUSY' });
  });

  it('the reader is content-type agnostic (missing header still expands)', async () => {
    const response = await app.fetch(new Request('http://t.test/api/config/snippets/expand', {
      method: 'POST', body: JSON.stringify({ text: 'x #sig y' }),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: 'x sig-text y' });
  });
});
