// SPDX-License-Identifier: Apache-2.0
/**
 * F9 creation-operation reconciliation for session orchestration (multi-run
 * creation): a duplicate submission after a lost acknowledgement replays the
 * original outcome, a changed payload under the same operation id is refused,
 * and an acceptance-unknown reservation is never blindly resubmitted — the
 * receipt lookup reports its state instead.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { sep } from 'node:path';
import { Hono } from 'hono';
import { afterAll, describe, expect, it } from 'vitest';
// Type-only: erased at load, so the env capture below still runs first.
import type { OrchestratorDeps } from '../session-orchestration/session-orchestration-contract.ts';

// The receipt file lives under the isolated data dir; the env capture happens
// at module load, so the store modules import dynamically AFTER this line.
const isolatedDataDir = mkdtempSync(`${tmpdir()}${sep}nnd-f9-ops-`);
process.env.NOTNATIVE_DATA_DIR = isolatedDataDir;

const { createSession, registerOpenChamberSessionRoutes } = await import('../session-orchestration/openchamber-sessions.ts');
const { fingerprintOf, readOperation, reserveOperation, settleOperation } =
  await import('../session-orchestration/session-operation-store.ts');

afterAll(() => { rmSync(isolatedDataDir, { recursive: true, force: true }); });

interface HarnessState { creates: number }

let state: HarnessState;

function harness(overrides: Partial<OrchestratorDeps['harness']> = {}): OrchestratorDeps {
  state = { creates: 0 };
  const ports: OrchestratorDeps['harness'] = {
    providers: async () => [],
    agents: async () => [],
    config: async () => ({}),
    commands: async () => [],
    createSession: async (directory, title) => {
      state.creates += 1;
      return { id: `ses_${state.creates}`, title, directory, time: { updated: 0 } };
    },
    readSession: async (sessionId) => {
      if (sessionId.startsWith('ses_')) return { id: sessionId, time: { updated: 0 } };
      throw new Error('unknown session');
    },
    readMessages: async () => [],
    sendPrompt: async () => ({ ok: true, status: 204 }),
    sendCommand: async () => ({ ok: true, status: 204 }),
    forkSession: async () => { throw new Error('not under test'); },
    archiveSession: async () => true,
    writeGoal: async () => true,
    patchSession: async (sessionId) => ({ id: sessionId }),
    ...overrides,
  };
  return {
    harness: ports,
    directoryExists: async () => true,
    now: () => 1,
  };
}

const baseInput = {
  scope: { directory: 'C:/repo' },
  title: 'Run A',
  operationId: 'runop_1',
} as const;

describe('creation operation receipts (operation store)', () => {
  it('reserves fresh, replays settled, rejects a changed payload, and reports pending', async () => {
    const fingerprint = fingerprintOf({ a: 1 });
    expect(await reserveOperation('storeop_1', fingerprint)).toEqual({ kind: 'fresh' });
    // duplicate reservation of the SAME reservation is pending (self), never fresh again
    expect(await reserveOperation('storeop_1', fingerprint)).toEqual({ kind: 'pending', live: false });
    await settleOperation('storeop_1', { ok: true, body: { sessionId: 'ses_x' } });
    const settled = await reserveOperation('storeop_1', fingerprint);
    expect(settled.kind).toBe('settled');
    if (settled.kind !== 'settled') throw new Error('unreachable');
    expect(settled.receipt.response).toEqual({ ok: true, body: { sessionId: 'ses_x' } });
    // a changed payload under the same id is refused
    expect(await reserveOperation('storeop_1', fingerprintOf({ a: 2 }))).toEqual({ kind: 'conflict' });
    expect(readOperation('storeop_1')?.state).toBe('settled');
  });

  it('a released reservation (definite pre-acceptance failure) may be reserved again', async () => {
    expect(await reserveOperation('storeop_2', 'fp')).toEqual({ kind: 'fresh' });
    await settleOperation('storeop_2', null); // release: the id returns to the pool
    expect(await reserveOperation('storeop_2', 'fp')).toEqual({ kind: 'fresh' });
  });
});

describe('createSession operation reconciliation', () => {
  it('a duplicate submission after a lost acknowledgement replays the ORIGINAL outcome', async () => {
    const deps = harness();
    const input = { ...baseInput, operationId: 'runop_dup' };
    const first = await createSession(deps, input);
    expect(first.ok).toBe(true);
    expect(state.creates).toBe(1);
    // the acknowledgement was lost; the client retries the same operationId
    const retry = await createSession(deps, input);
    expect(retry).toEqual(first); // the ORIGINAL envelope replays
    expect(state.creates).toBe(1); // no second native session
  });

  it('a changed payload under the same operationId is refused', async () => {
    const deps = harness();
    const first = await createSession(deps, { ...baseInput, operationId: 'runop_conflict' });
    expect(first.ok).toBe(true);
    const changed = await createSession(deps, { ...baseInput, operationId: 'runop_conflict', title: 'Run B' });
    expect(changed.ok).toBe(false);
    if (changed.ok) throw new Error('unreachable');
    expect(changed.failure.status).toBe(409);
    expect(state.creates).toBe(1);
  });

  it('an acceptance-unknown failure keeps the reservation pending and never resubmits', async () => {
    let attempts = 0;
    const deps = harness({
      createSession: async (directory, title) => {
        attempts += 1;
        void directory; void title;
        throw new Error('harness adapter unavailable'); // 502 → acceptance unknown
      },
    });
    const input = { ...baseInput, operationId: 'runop_unknown' };
    const first = await createSession(deps, input);
    expect(first.ok).toBe(false);
    if (first.ok) throw new Error('unreachable');
    expect(first.failure.status).toBe(502);
    expect(attempts).toBe(1);
    const receipt = readOperation('runop_unknown');
    expect(receipt?.state).toBe('pending'); // outcome unknown: still reserved
    // the blind retry must NOT resubmit the creation
    const retry = await createSession(deps, input);
    expect(retry.ok).toBe(false);
    if (retry.ok) throw new Error('unreachable');
    expect(retry.failure.status).toBe(503);
    expect(attempts).toBe(1);
    expect(String(retry.failure.error)).toContain('unknown outcome');
  });

  it('a definite pre-acceptance validation failure releases the id for a corrected retry', async () => {
    const deps: OrchestratorDeps = { ...harness(), directoryExists: async () => false };
    const bad = await createSession(deps, {
      scope: { directory: 'C:/missing' }, title: 'Run A', operationId: 'runop_fix',
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) throw new Error('unreachable');
    expect(bad.failure.status).toBe(400); // rejected before any native acceptance
    expect(readOperation('runop_fix')).toBeNull(); // released: the id returns to the pool
    expect(state.creates).toBe(0);
    // the corrected retry (same id, valid scope) runs normally
    const fixed = await createSession(harness(), { ...baseInput, operationId: 'runop_fix' });
    expect(fixed.ok).toBe(true);
  });

  it('the receipt lookup route reports the stored operation state', async () => {
    const deps = harness();
    const app = new Hono();
    registerOpenChamberSessionRoutes(app, deps);
    const created = await createSession(deps, { ...baseInput, operationId: 'runop_route' });
    expect(created.ok).toBe(true);
    const response = await app.fetch(new Request('http://ops.test/api/openchamber/sessions/operations/runop_route'));
    expect(response.status).toBe(200);
    const receipt = await response.json() as { state: string; response?: { ok?: boolean } };
    expect(receipt.state).toBe('settled');
    expect(receipt.response?.ok).toBe(true);
    const missing = await app.fetch(new Request('http://ops.test/api/openchamber/sessions/operations/runop_absent'));
    expect(missing.status).toBe(404);
  });
});
