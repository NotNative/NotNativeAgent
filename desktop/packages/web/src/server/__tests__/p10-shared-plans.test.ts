// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

const baseDataDir = mkdtempSync(join(tmpdir(), 'nnd-p10-shared-'));
let checkout = '';
let registerProjectsRoutes: typeof import('../routes/projects.ts').registerProjectsRoutes;

beforeEach(async () => {
  process.env.NOTNATIVE_DATA_DIR = mkdtempSync(join(tmpdir(), 'nnd-p10-shared-storage-'));
  checkout = mkdtempSync(join(tmpdir(), 'nnd-p10-shared-checkout-'));
  mkdirSync(join(checkout, '.openchamber'), { recursive: true });
  ({ registerProjectsRoutes } = await import('../routes/projects.ts'));
});

afterEach(() => {
  rmSync(process.env.NOTNATIVE_DATA_DIR ?? `${baseDataDir}-gone`, { recursive: true, force: true });
  rmSync(checkout, { recursive: true, force: true });
});

afterAll(() => rmSync(baseDataDir, { recursive: true, force: true }));

function app(): Hono { const instance = new Hono(); registerProjectsRoutes(instance); return instance; }
function json(body: unknown, method = 'POST'): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

async function createPlan(api: Hono, projectId: string, title: string): Promise<{ id: string; file: string }> {
  const response = await api.request(`/api/project-context/${projectId}/plans`, json({ title, body: 'Steps' }));
  expect(response.status).toBe(201);
  const payload = await response.json() as { plan: { id: string; file: string } };
  return payload.plan;
}

describe('P10 shared plans', () => {
  it('shares and unshares a personal manifest plan without losing its ID or content', async () => {
    const api = app();
    const plan = await createPlan(api, 'alpha', 'Launch');
    const personalBefore = join(process.env.NOTNATIVE_DATA_DIR!, 'projects', 'alpha', 'plans', plan.file);
    expect(existsSync(personalBefore)).toBe(true);
    const response = await api.request(
      `/api/project-context/alpha/plans/${plan.id}/share?directory=${encodeURIComponent(checkout)}`, { method: 'POST' });
    expect(response.status).toBe(200);
    const shared = await response.json() as {
      plan: { id: string; file: string; shared: boolean };
      context: { plans: Array<{ id: string; shared?: boolean }> };
      sharedPlansDir: string;
    };
    expect(shared.sharedPlansDir).toBe(join(checkout, '.openchamber', 'plans'));
    expect(shared.plan).toMatchObject({ id: plan.id, file: plan.file, shared: true });
    expect(shared.context.plans).toMatchObject([{
      id: plan.id, file: plan.file, shared: true,
    }]);
    expect(existsSync(personalBefore)).toBe(false);
    const sharedPath = join(shared.sharedPlansDir, plan.file);
    expect(readFileSync(sharedPath, 'utf8')).toBe('# Launch\n\nSteps\n');
    const read = await api.request(`/api/project-context/alpha/plans/${plan.id}?directory=${encodeURIComponent(checkout)}`);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ title: 'Launch', body: 'Steps', raw: '# Launch\n\nSteps\n' });
    const updated = await api.request(
      `/api/project-context/alpha/plans/${plan.id}?directory=${encodeURIComponent(checkout)}`,
      json({ raw: '# Renamed\n\nSame plan' }, 'PUT'));
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ plan: { title: 'Renamed', file: plan.file } });
    expect(readFileSync(sharedPath, 'utf8')).toBe('# Renamed\n\nSame plan');
    const unshared = await api.request(
      `/api/project-context/alpha/plans/${plan.id}/unshare?directory=${encodeURIComponent(checkout)}`, { method: 'POST' });
    expect(unshared.status).toBe(200);
    const unsharedPayload = await unshared.json() as {
      plan: { id: string; file: string; shared: boolean };
      context: { plans: Array<{ id: string; file?: string; shared?: boolean }> };
    };
    expect(unsharedPayload.plan).toMatchObject({ id: plan.id, file: plan.file, shared: false });
    expect(unsharedPayload.context.plans).toMatchObject([{ id: plan.id, file: plan.file, shared: false }]);
    expect(existsSync(join(personalBefore))).toBe(true);
    expect(existsSync(sharedPath)).toBe(false);
  });

  it('lists, reads, edits, and deletes an unclaimed shared file using the expected ID', async () => {
    const api = app();
    const directory = encodeURIComponent(checkout);
    const contextDir = join(process.env.NOTNATIVE_DATA_DIR!, 'projects', 'team');
    mkdirSync(contextDir, { recursive: true });
    const context = join(contextDir, 'context.json');
    writeFileSync(context, JSON.stringify({ version: 2, notes: [], todos: [], plans: [] }));
    const sharedDir = join(checkout, '.openchamber', 'plans');
    mkdirSync(sharedDir, { recursive: true });
    const shared = join(sharedDir, 'team-plan.md');
    writeFileSync(shared, '# Team plan\n\nWork');
    const listed = await api.request(`/api/project-context/team?directory=${directory}`);
    expect(listed.status).toBe(200);
    const contextPayload = await listed.json() as {
      plans: Array<{ id: string; file: string; title: string; source: string }>;
      sharedPlansDir: string;
    };
    expect(contextPayload.plans).toMatchObject([{ id: 'shared:team-plan.md', file: 'team-plan.md', title: 'Team plan', source: 'shared' }]);
    expect(contextPayload.sharedPlansDir).toBe(join(checkout, '.openchamber', 'plans'));
    const read = await api.request(`/api/project-context/team/plans/shared%3Ateam-plan.md?directory=${directory}`);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ id: 'shared:team-plan.md', title: 'Team plan', body: 'Work' });
    const updated = await api.request(`/api/project-context/team/plans/shared%3Ateam-plan.md?directory=${directory}`,
      json({ raw: '# Updated\n\nShared' }, 'PUT'));
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ plan: { title: 'Updated' }, raw: '# Updated\n\nShared' });
    expect(readFileSync(shared, 'utf8')).toBe('# Updated\n\nShared');
    expect((await (await api.request(`/api/project-context/team?directory=${directory}`)).json() as {
      plans: unknown[];
    }).plans).toHaveLength(1);
    const deleted = await api.request(`/api/project-context/team/plans/shared%3Ateam-plan.md?directory=${directory}`, { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toMatchObject({ plans: [] });
    expect(existsSync(shared)).toBe(false);
  });

  it('honours a nested team configured plansDir and refuses missing checkout scope', async () => {
    const api = app();
    const root = join(checkout, 'feature-team-plans');
    const directory = encodeURIComponent(checkout);
    writeFileSync(join(checkout, '.openchamber', 'project.json'), JSON.stringify({ plansDir: 'feature-team-plans' }));
    const shared = join(root, 'team-plan.md');
    mkdirSync(root, { recursive: true });
    writeFileSync(shared, '# Team configured\n\nWork');
    const listed = await api.request('/api/project-context/team?directory=' + directory);
    const teamContext = await listed.json() as { plans: Array<{ id: string }>; sharedPlansDir: string };
    expect(teamContext.sharedPlansDir).toBe(root);
    expect(teamContext.plans).toHaveLength(1);
    expect(teamContext.plans[0]).toMatchObject({ id: 'shared:team-plan.md' });
    const noCheckout = await api.request('/api/project-context/team/plans/shared%3Ateam-plan.md');
    expect(noCheckout.status).toBe(400);
    const noCheckoutShare = await api.request('/api/project-context/team/plans/p1/share', { method: 'POST' });
    expect(noCheckoutShare.status).toBe(400);
  });

  it('maps shared-context checkout input errors to the route client error', async () => {
    const api = app();
    const response = await api.request(`/api/project-context/team?directory=${encodeURIComponent('   ')}`);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'project checkout directory is required' });
  });
});
