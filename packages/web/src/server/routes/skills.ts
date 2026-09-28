// SPDX-License-Identifier: Apache-2.0
import type { Hono } from 'hono';
import { externalSkillFlags, scanLocalSkills } from '../lib/skills/skill-scan.ts';

export function registerSkillRoutes(app: Hono): void {
  app.get('/api/config/skills', (c) => {
    try {
      const externalSkills = externalSkillFlags();
      return c.json({
        skills: scanLocalSkills(c.req.query('directory') ?? ''),
        externalSkills,
      });
    } catch { return c.json({ error: 'project checkout directory is required' }, 400); }
  });
  app.get('/api/config/skills/:name', (c) => {
    try {
      const skill = scanLocalSkills(c.req.query('directory') ?? '')
        .find((entry) => entry.name === c.req.param('name'));
      if (!skill) return c.json({ error: 'skill not found' }, 404);
      return c.json(skill);
    } catch { return c.json({ error: 'project checkout directory is required' }, 400); }
  });
}
