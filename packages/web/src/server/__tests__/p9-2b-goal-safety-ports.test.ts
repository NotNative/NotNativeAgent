// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { registerHarnessAdapter } from '../harness/adapter.ts';
import { buildGoalPayload } from '../goals/goal-payload.ts';
import { createNnaGoalSafetyPorts } from '../goals/nna-goal-safety-ports.ts';
import type { ObjectiveStore } from '../goals/objective-store.ts';

const goal = buildGoalPayload({ objective: 'Inline fallback', objectiveFile: true, now: 10 });

describe('NNA goal safety production ports', () => {
  it('routes reads through the authenticated harness adapter with directory scope', async () => {
    const seen: string[] = [];
    registerHarnessAdapter({ handle: async (request) => {
      const url = new URL(request.url);
      seen.push(`${request.method} ${url.pathname}${url.search} ${request.headers.get('x-nnd-directory')}`);
      return Response.json({ ok: true });
    } });
    const ports = createNnaGoalSafetyPorts({ read: async () => null } as unknown as ObjectiveStore);
    await ports.readSession('ses_1', '/project');
    await ports.readStatus('/project');
    await ports.readChildren('ses_1', '/project');
    await ports.readMessages('ses_1', '/project', 500);
    await ports.readEvidence('ses_1', '/project');
    expect(seen).toEqual([
      'GET /api/session/ses_1 /project', 'GET /api/session/status /project',
      'GET /api/session/ses_1/children /project', 'GET /api/session/ses_1/message?limit=40 /project',
      'GET /api/v1/nnd/sessions/ses_1/goal-evidence /project',
    ]);
  });

  it('reads immutable file generations and falls back only on a missing file', async () => {
    let seenKey = '';
    const store = { read: async (_id: string, key: string) => { seenKey = key; return null; } } as ObjectiveStore;
    const ports = createNnaGoalSafetyPorts(store);
    expect(await ports.readObjective({ ...goal, objectiveFileKey: 'a'.repeat(64) }, 'ses_1')).toBe('Inline fallback');
    expect(seenKey).toBe('a'.repeat(64));
    expect(await ports.readObjective({ ...goal, objectiveFile: false }, 'ses_1')).toBe('Inline fallback');
    expect(await createNnaGoalSafetyPorts({ read: async () => { throw new Error('unsafe'); } } as unknown as ObjectiveStore)
      .readObjective(goal, 'ses_1')).toBeNull();
  });

  it('confirms the returned revision and goal identity after a CAS write', async () => {
    const requests: unknown[] = [];
    let response: unknown = { goal, revision: 4 };
    registerHarnessAdapter({ handle: async (request) => {
      requests.push(JSON.parse(await request.text()));
      return Response.json(response);
    } });
    const ports = createNnaGoalSafetyPorts();
    const body = { goal, expected_id: goal.id, expected_revision: 3 };
    expect(await ports.writeGoal('ses_1', '/project', body)).toBe(true);
    expect(requests).toEqual([body]);
    response = { goal: { id: 'other' }, revision: 4 };
    expect(await ports.writeGoal('ses_1', '/project', body)).toBe(false);
    response = { goal, revision: 3 };
    expect(await ports.writeGoal('ses_1', '/project', body)).toBe(false);
  });
});
