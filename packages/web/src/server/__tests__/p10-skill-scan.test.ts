// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { registerSkillRoutes } from '../routes/skills.ts';
import { externalSkillFlags, scanLocalSkills } from '../lib/skills/skill-scan.ts';

const base = mkdtempSync(join(tmpdir(), 'nnd-p10-skills-'));
let checkout = '';

beforeEach(() => {
  checkout = mkdtempSync(join(base, 'checkout-'));
  const nested = join(checkout, '.agents', 'skills', 'review-flow', 'steps');
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, 'SKILL.md'), '---\nname: review-flow\ndescription: Run the review checklist\n---\nDo it.');
  delete process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS;
  delete process.env.OPENCODE_DISABLE_CLAUDE_SKILLS;
  delete process.env.OPENCODE_DISABLE_CLAUDE_CODE;
});

function app(): Hono {
  const instance = new Hono();
  registerSkillRoutes(instance);
  return instance;
}

describe('P10 skill discovery', () => {
  it('requires a checkout scope and reports project skills with external flags', async () => {
    const missing = await app().request('/api/config/skills');
    expect(missing.status).toBe(400);
    const listed = await app().request(`/api/config/skills?directory=${encodeURIComponent(checkout)}`);
    const payload = await listed.json() as {
      skills: Array<{ name: string; source: string; scope: string; group?: string; path: string }>;
      externalSkills: { claudeDisabled: boolean; allDisabled: boolean };
    };
    expect(listed.status).toBe(200);
    const skill = payload.skills.find((entry) => entry.name === 'review-flow');
    expect(skill).toMatchObject({ source: 'agents', scope: 'project', group: 'review-flow', renamable: false });
    expect(skill?.path.startsWith(checkout)).toBe(true);
    expect(payload.externalSkills).toEqual({ claudeDisabled: false, allDisabled: false });
    expect(externalSkillFlags().allDisabled).toBe(false);
  });

  it('finds one scanned skill and hides agents skills only when globally disabled', async () => {
    const skill = scanLocalSkills(checkout).find((entry) => entry.name === 'review-flow');
    expect(skill?.description).toBe('Run the review checklist');
    process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = '1';
    const routes = app();
    const response = await routes.request(
      `/api/config/skills/review-flow?directory=${encodeURIComponent(checkout)}`);
    expect(response.status).toBe(404);
  });

  it('parses only the opening document block and keeps discovery read-only', () => {
    const nested = join(checkout, '.agents', 'skills', 'review-flow');
    writeFileSync(join(nested, 'SKILL.md'),
      '---\nname: review-flow\ndescription: Run the review checklist\n---\nname: body-name\ndescription: body description');
    const skill = scanLocalSkills(checkout).find((entry) => entry.name === 'review-flow');
    expect(skill).toMatchObject({
      name: 'review-flow', description: 'Run the review checklist', renamable: false,
    });
  });

  it('hides project agents skills and their detail route when external skills are disabled', async () => {
    process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = '1';
    const listed = await app().request(`/api/config/skills?directory=${encodeURIComponent(checkout)}`);
    const payload = await listed.json() as { skills: Array<{ name: string }> };
    expect(payload.skills).toEqual([]);
    const detail = await app().request(
      `/api/config/skills/review-flow?directory=${encodeURIComponent(checkout)}`);
    expect(detail.status).toBe(404);
  });
});
