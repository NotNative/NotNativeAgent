// SPDX-License-Identifier: Apache-2.0
/**
 * P9-1 item parse + preview + store persistence gates (doc 12 §D.1/§D.2):
 * validation matrix (size, attachment completeness, context envelope,
 * need-one-of, sendConfig), snapshot preview derivation, and the store:
 * monotone global revision, missing/malformed/hard-read-failure postures,
 * atomic pid-suffixed temp names, serialized writes, emptied-session
 * exclusion, and the enqueue limits (20 items newest-kept in-flight-safe,
 * 50 sessions oldest-first, never an in-flight session).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MessageQueueStore, QUEUE_FILE_NAME, queueTempPath } from '../queue/queue-store.ts';
import {
  deriveSnapshotPreview,
  parseQueuedItemInput,
  publicQueueItem,
  QueueItemValidationError,
  type QueueItem,
} from '../queue/queue-item.ts';
import { rawItem, WORK_TREE } from './helpers/queue-fakes.ts';

const dir = mkdtempSync(`${tmpdir()}${sep}nnd-p91-store-`);
const storeFile = joinPath(dir, QUEUE_FILE_NAME);

const freshStore = (): MessageQueueStore =>
  new MessageQueueStore(joinPath(mkdtempSync(`${tmpdir()}${sep}nnd-p91-s2-`), QUEUE_FILE_NAME));

const item = (id: string, overrides: Record<string, unknown> = {}): QueueItem =>
  parseQueuedItemInput({ ...rawItem(overrides), id });

function expectReject(fn: () => unknown, contains: string): void {
  try {
    fn();
    expect.fail(`expected rejection mentioning ${contains}`);
  } catch (error) {
    expect(error).toBeInstanceOf(QueueItemValidationError);
    expect((error as Error).message).toContain(contains);
  }
}

const readValue = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;

describe('parseQueuedItemInput (§D.1)', () => {
  it('rejects content over 200 000 chars; accepts the cap and trims newline edges', () => {
    expectReject(() => parseQueuedItemInput({ ...rawItem(), content: 'x'.repeat(200_001) }), '200000');
    const parsed = parseQueuedItemInput({ ...rawItem(), content: '\nfirst\nlast\n\n' });
    expect(parsed.content).toBe('first\nlast');
    expect(parsed.content.length).toBeLessThanOrEqual(200_000);
  });

  it('unknown attachment source coerces to local; known sources ride verbatim', () => {
    const attachment = { id: 'a1', filename: 'a.bin', mimeType: 'application/x', size: 3, dataUrl: 'data:application/x;base64,AAA' };
    const coerced = parseQueuedItemInput({ ...rawItem(), attachments: [{ ...attachment, source: 'warp' }] });
    expect(coerced.attachments[0]!.source).toBe('local');
    const vscode = parseQueuedItemInput({ ...rawItem(), attachments: [{ ...attachment, source: 'vscode' }] });
    expect(vscode.attachments[0]!.source).toBe('vscode');
  });

  it('one unparseable attachment rejects the WHOLE item (filename/mimeType/dataUrl required)', () => {
    const attachment = { id: 'a1', filename: 'a.bin', mimeType: 'application/x', dataUrl: 'data:;base64,AAA' };
    expect(parseQueuedItemInput({ ...rawItem(), content: 'ok', attachments: [attachment] }).attachments).toHaveLength(1);
    expectReject(() => parseQueuedItemInput({ ...rawItem(), content: 'ok', attachments: [attachment, { id: 'a2', filename: 'b' }] }), 'attachments[1]');
    expectReject(() => parseQueuedItemInput({ ...rawItem(), content: 'ok', attachments: [{ id: 'a3', mimeType: 'text/x', filename: 'c' }] }), 'dataUrl');
  });

  it('context kinds are the three; context kind REQUIRES a metadata object', () => {
    const withContext = parseQueuedItemInput({
      ...rawItem(),
      content: 'c',
      context: [
        { kind: 'context', text: 'ctx body', metadata: { key: 'v' }, instructions: 'explain this' },
        { kind: 'instruction', text: 'be terse' },
        { kind: 'synthetic', text: 'sys' },
      ],
    });
    expect(withContext.context).toHaveLength(3);
    expectReject(() => parseQueuedItemInput({ ...rawItem(), content: 'c', context: [{ kind: 'context', text: 'x' }] }), 'metadata');
    expectReject(() => parseQueuedItemInput({ ...rawItem(), content: 'c', context: [{ kind: 'context', text: 'x', metadata: [1] }] }), 'metadata');
    expectReject(() => parseQueuedItemInput({ ...rawItem(), content: 'c', context: [{ kind: 'snippet', text: 'x' }] }), 'kind');
  });

  it('needs at least one of text/attachments/context; attachment-only queue is fine', () => {
    expectReject(() => parseQueuedItemInput(rawItem({ content: '' })), 'requires text');
    const onlyAttachment = parseQueuedItemInput({
      ...rawItem({ content: '' }),
      attachments: [{ id: 'a1', filename: 'a.png', mimeType: 'image/png', size: 1, dataUrl: 'data:image/png;base64,AA' }],
    });
    expect(onlyAttachment.text).toBe('');
    const onlyContext = parseQueuedItemInput({ ...rawItem({ content: '' }), context: [{ kind: 'synthetic', text: 's' }] });
    expect(onlyContext.context).toHaveLength(1);
  });

  it('sendConfig with providerID+modelID is mandatory; agent/variant optional', () => {
    expectReject(() => parseQueuedItemInput({ content: 'x' }), 'sendConfig');
    expectReject(() => parseQueuedItemInput({ content: 'x', sendConfig: { providerID: 'p' } }), 'modelID');
    const full = parseQueuedItemInput({ content: 'x', sendConfig: { providerID: 'p', modelID: 'm', agent: 'build', variant: 'v1' } });
    expect(full.sendConfig).toEqual({ providerID: 'p', modelID: 'm', agent: 'build', variant: 'v1' });
  });

  it('agent mention strips from text and rides the dedicated field; text defaults to content', () => {
    const mentioned = parseQueuedItemInput(rawItem({ content: '@scout check the logs' }));
    expect(mentioned.agentMention).toBe('scout');
    expect(mentioned.text).toBe('check the logs');
    const plain = parseQueuedItemInput(rawItem());
    expect(plain.agentMention).toBeUndefined();
    expect(plain.text).toBe('queued text');
    const overridden = parseQueuedItemInput(rawItem({ content: 'raw', text: '@scout follow the plan' }));
    expect(overridden.agentMention).toBe('scout');
    expect(overridden.text).toBe('follow the plan');
  });

  it('contextPreview clips to 103 stored chars; ids look like queued-<ms>-<rand 7>', () => {
    const parsed = parseQueuedItemInput(rawItem({ contextPreview: 'p'.repeat(200) }));
    expect(parsed.contextPreview).toHaveLength(103);
    expect(parsed.id).toMatch(/^queued-\d+-[0-9a-f]{7}$/u);
  });

  it('metadata rides verbatim as the courier; schema matter stays UI business (§D.1)', () => {
    const parsed = parseQueuedItemInput({
      ...rawItem(),
      content: 'c',
      context: [{ kind: 'context', text: 't', metadata: { comment: { line: 12, text: 'nit' } } }],
    });
    expect((parsed.context[0] as { metadata: unknown }).metadata).toEqual({ comment: { line: 12, text: 'nit' } });
  });
});

describe('snapshot preview derivation (§D.1)', () => {
  it('dataUrl and context never reach a public projection; preview rides derived', () => {
    const parsed = parseQueuedItemInput(rawItem({
      content: 'hello there',
      contextPreview: 'cp',
      attachments: [{ id: 'a1', filename: 'a.png', mimeType: 'image/png', size: 9, dataUrl: 'data:image/png;base64,SECRET' }],
      context: [{ kind: 'context', text: 'ctx', metadata: { k: 1 } }],
    }));
    const output = publicQueueItem(parsed);
    expect(JSON.stringify(output)).not.toContain('SECRET');
    expect('context' in output).toBe(false);
    expect(output.attachments[0]!.source).toBe('local');
    expect(output.preview).toBe('hello there'); // single short line: nothing truncated, no ellipsis
  });

  it('preview clips to 100 chars; short single-line content stays bare', () => {
    const long = parseQueuedItemInput(rawItem({ content: `${'y'.repeat(250)} tail` }));
    expect(deriveSnapshotPreview(long)).toBe(`${'y'.repeat(100)}...`);
    const exact = parseQueuedItemInput(rawItem({ content: 'y'.repeat(100) }));
    expect(deriveSnapshotPreview(exact)).toBe('y'.repeat(100));
    const multiline = parseQueuedItemInput(rawItem({ content: 'short\nmore below' }));
    expect(deriveSnapshotPreview(multiline)).toBe('short...');
  });

  it('legacy chain: attached comment metadata text, then first non-instruction context text', () => {
    const comment = parseQueuedItemInput(rawItem({
      content: '',
      context: [{ kind: 'context', text: 'ctx text', metadata: { text: 'inline review comment' } }],
    }));
    expect(deriveSnapshotPreview(comment)).toBe('inline review comment');
    const freefall = parseQueuedItemInput(rawItem({
      content: '',
      context: [{ kind: 'instruction', text: 'skip me' }, { kind: 'synthetic', text: 'first non-instruction' }],
    }));
    expect(deriveSnapshotPreview(freefall)).toBe('first non-instruction');
  });
});

describe('store persistence (§D.2)', () => {
  it('revision bumps monotonically on every mutation and persists the whole doc', async () => {
    const store = freshStore();
    const first = store.enqueue('s1', WORK_TREE, item('a', { content: 'one' }), () => null);
    const second = store.enqueue('s1', WORK_TREE, item('b', { content: 'two' }), () => null);
    expect(second).toBe(first + 1);
    await store.flushWrites();
    const doc = readValue(store.file) as unknown as { version: number; revision: number; sessions: Record<string, { directory: string; items: QueueItem[] }> };
    expect(doc.version).toBe(1);
    expect(doc.revision).toBe(second);
    expect(doc.sessions.s1!.items.map((entry) => entry.id)).toEqual(['a', 'b']);
  });

  it('missing file boots empty; a reloaded store replaces from disk and keeps the revision', async () => {
    const shared = joinPath(mkdtempSync(`${tmpdir()}${sep}nnd-p91-s3-`), QUEUE_FILE_NAME);
    const boot = new MessageQueueStore(shared);
    expect(boot.load()).toBe('missing');
    expect(boot.currentRevision).toBe(0);
    boot.enqueue('s1', WORK_TREE, item('a'), () => null);
    await boot.flushWrites();
    const reborn = new MessageQueueStore(shared);
    expect(reborn.load()).toBe('loaded');
    expect(reborn.entryOf('s1')?.items).toHaveLength(1);
    expect(reborn.currentRevision).toBe(1);
    expect(reborn.commit()).toBe(2);
  });

  it('malformed file renames aside to corrupt-<timestamp> before starting empty', async () => {
    writeFileSync(storeFile, '{definitely not json');
    const store = new MessageQueueStore(storeFile);
    expect(store.load()).toBe('quarantined');
    expect(existsSync(storeFile)).toBe(false);
    const renamed = readdirSync(dir).filter((name) => name.startsWith(`${QUEUE_FILE_NAME}.corrupt-`));
    expect(renamed).toHaveLength(1);
    expect(/^message-queue\.json\.corrupt-\d+$/u.test(renamed[0]!)).toBe(true);
    store.enqueue('s1', WORK_TREE, item('a'), () => null);
    await store.flushWrites();
    expect(readValue(storeFile).revision).toBe(1); // the next write cannot clobber the user's data
  });

  it('wrong-shape but valid JSON counts as malformed (version/revision/sessions gates)', () => {
    const quarantine = freshStore();
    writeFileSync(quarantine.file, JSON.stringify({ version: 2, sessions: {} }));
    expect(quarantine.load()).toBe('quarantined');
    const revisionType = freshStore();
    writeFileSync(revisionType.file, JSON.stringify({ version: 1, revision: 'nine', sessions: {} }));
    expect(revisionType.load()).toBe('quarantined');
  });

  it('hard read failure disables writes; memory stays; recovery re-enables without reverting', async () => {
    const probe = joinPath(mkdtempSync(`${tmpdir()}${sep}nnd-p91-s4-`), QUEUE_FILE_NAME);
    mkdirSync(probe); // a directory at the file path = every read fails hard
    const store = new MessageQueueStore(probe);
    expect(store.load()).toBe('disabled');
    expect(store.writesEnabled).toBe(false);
    const revision = store.enqueue('s1', WORK_TREE, item('a'), () => null);
    expect(store.entryOf('s1')?.items).toHaveLength(1); // in-memory queue stays
    await store.flushWrites();
    rmSync(probe, { recursive: true });
    writeFileSync(probe, '{"version":1,"revision":900,"sessions":{}}'); // stale disk state
    expect(store.recoverWrites()).toBe(true);
    expect(store.writesEnabled).toBe(true);
    await store.flushWrites();
    const doc = readValue(probe) as unknown as { revision: number; sessions: Record<string, unknown> };
    expect(doc.revision).toBe(revision); // in-memory won: the stale 900 was never adopted
    expect(doc.sessions.s1).toBeDefined();
    expect(store.recoverWrites()).toBe(true); // a second recovery probe stays healthy
  });

  it('atomic writes are pid-suffixed tmp + rename through one serialized chain', async () => {
    expect(queueTempPath(storeFile, 7)).toContain(`.tmp-${process.pid}-7`);
    const store = freshStore();
    store.enqueue('s1', WORK_TREE, item('a'), () => null);
    store.enqueue('s1', WORK_TREE, item('b'), () => null);
    await store.flushWrites();
    expect(readValue(store.file).revision).toBe(2); // serialized chain ends at the newest state
    const left = readdirSync(joinPath(store.file, '..'));
    expect(left.some((name) => name.includes('.tmp-'))).toBe(false);
  });

  it('emptied sessions leave the disk doc but keep the directory memory in store', async () => {
    const store = freshStore();
    store.enqueue('s1', WORK_TREE, item('a'), () => null);
    store.removeItem('s1', 'a');
    store.commit();
    await store.flushWrites();
    const persisted = readValue(store.file) as { sessions: Record<string, unknown> };
    expect(Object.keys(persisted.sessions)).toEqual([]); // memory-only now (§D.2)
    expect(store.entryOf('s1')).toBeDefined(); // directory memory survived
  });

  it('the 21st item drops the oldest (newest kept); the in-flight head stays pinned', async () => {
    const store = freshStore();
    store.enqueue('s1', WORK_TREE, item('pinned', { content: 'head' }), (sessionId) => (sessionId === 's1' ? 'pinned' : null));
    for (let index = 1; index <= 19; index += 1) store.enqueue('s1', WORK_TREE, item(`old-${index}`), () => null);
    expect(store.entryOf('s1')!.items).toHaveLength(20);
    store.enqueue('s1', WORK_TREE, item('brand-new'), (sessionId) => (sessionId === 's1' ? 'pinned' : null));
    const kept = store.entryOf('s1')!.items.map((entry) => entry.id);
    expect(kept).toHaveLength(20);
    expect(kept[0]).toBe('pinned'); // in-flight head never evicted
    expect(kept).toContain('brand-new'); // newest kept
    expect(kept).not.toContain('old-1'); // oldest non-in-flight dropped
    expect(kept).toContain('old-2');
  });

  it('the 51st session evicts oldest-first by first item createdAt; in-flight and memory-only align', async () => {
    const store = freshStore();
    for (let index = 1; index <= 50; index += 1) {
      store.enqueue(`s-${String(index).padStart(2, '0')}`, WORK_TREE, item(`i-${index}`, { createdAt: 1000 + index }), () => null);
    }
    expect(store.nonEmptyEntries()).toHaveLength(50);
    const inFlight = (id: string): string | null => (id === 's-01' ? 'i-1' : null); // state-based, as the runtime feeds it
    // the OLDEST session went in flight: eviction must skip it
    store.enqueue('s-01', WORK_TREE, item('i-1-dup', { createdAt: 1001 }), inFlight);
    store.enqueue('s-51', WORK_TREE, item('i-51', { createdAt: 1051 }), inFlight);
    const sessions = new Set(store.nonEmptyEntries().map((entry) => entry.sessionId));
    expect(sessions.has('s-01')).toBe(true); // never evict an in-flight session
    expect(sessions.has('s-02')).toBe(false); // next oldest evicted instead
    expect(sessions.size).toBe(50);
  });

  it('memory-only sessions evict before item-holding sessions (nothing persisted to lose)', () => {
    const store = freshStore();
    store.enqueue('holder', WORK_TREE, item('item', { createdAt: 500 }), () => null);
    for (let index = 0; index < 50; index += 1) {
      store.enqueue(`mem-${index}`, WORK_TREE, item(`mem-item-${index}`), () => null);
      store.removeItem(`mem-${index}`, `mem-item-${index}`);
    }
    store.enqueue('fresh', WORK_TREE, item('fresh-item', { createdAt: 4000 }), () => null);
    const sessions = new Set(store.nonEmptyEntries().map((entry) => entry.sessionId));
    expect(sessions.has('holder')).toBe(true); // item holder survived the memory sweep
    expect(sessions.has('fresh')).toBe(true); // newest session survived
    expect(store.entryOf('mem-0')).toBeNull(); // memory entries went first
    expect(store.entryOf('mem-2')).not.toBeNull(); // enough memory entries remained
  });
});
