// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
  it('scans ancestor roots through the Git worktree boundary', () => {
    const repo = mkdtempSync(join(tmpdir(), 'nnd-p10-skills-git-'));
    const nested = join(repo, 'nested', 'checkout');
    execFileSync('git', ['-C', repo, 'init'], { stdio: 'ignore', windowsHide: true });
    mkdirSync(join(repo, '.claude', 'skills', 'worktree-root'), { recursive: true });
    mkdirSync(join(nested, '.agents', 'skills', 'nested-skill'), { recursive: true });
    writeFileSync(join(repo, '.claude', 'skills', 'worktree-root', 'SKILL.md'),
      '---\nname: worktree-root\ndescription: Root checklist\n---');
    writeFileSync(join(nested, '.agents', 'skills', 'nested-skill', 'SKILL.md'),
      '---\nname: nested-skill\ndescription: Nested checklist\n---');
    try {
      const nestedNames = scanLocalSkills(nested).map((skill) => skill.name);
      const rootNames = scanLocalSkills(repo).map((skill) => skill.name);
      expect(nestedNames).toContain('worktree-root');
      expect(nestedNames).toContain('nested-skill');
      expect(rootNames).toContain('worktree-root');
      expect(rootNames).not.toContain('nested-skill');
    } finally {
      process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = undefined;
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('keeps ancestor skills when Windows path case differs from the Git root', () => {
    const repo = mkdtempSync(join(tmpdir(), 'nnd-p10-skills-case-'));
    const nested = join(repo, 'Nested', 'Checkout');
    execFileSync('git', ['-C', repo, 'init'], { stdio: 'ignore', windowsHide: true });
    mkdirSync(join(repo, '.claude', 'skills', 'case-root'), { recursive: true });
    writeFileSync(join(repo, '.claude', 'skills', 'case-root', 'SKILL.md'),
      '---\nname: case-root\ndescription: Case-safe root\n---');
    try {
      const requested = realpathSync(repo).slice(0, 1).toLowerCase()
        + realpathSync(repo).slice(1).toUpperCase();
      expect(scanLocalSkills(requested).map((skill) => skill.name)).toContain('case-root');
    } finally {
      process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = undefined;
      rmSync(repo, { recursive: true, force: true });
    }
  });

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
