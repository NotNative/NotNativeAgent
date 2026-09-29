// SPDX-License-Identifier: Apache-2.0
import type { Hono } from 'hono';
import { linkSync, mkdirSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { directAbsolute, externalSkillFlags, scanLocalSkills } from '../lib/skills/skill-scan.ts';

const SKILL_NAME = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/u;
const MAX_INSTRUCTIONS_BYTES = 512 * 1024;
const MAX_SKILL_BODY_BYTES = 2 * 1024 * 1024;

interface SkillCreateShape {
  description?: unknown; instructions?: unknown; source?: unknown; scope?: unknown;
  [key: string]: unknown;
}

interface ValidatedSkillCreate {
  description: string; instructions: string; scope: 'user' | 'project';
}

async function readBoundedSkillBody(raw: Request): Promise<string | null> {
  const reader = raw.body?.getReader();
  if (reader === undefined) return null;
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let next = await reader.read();
  while (!next.done) {
    const chunk = next.value ?? new Uint8Array(0);
    chunks.push(chunk);
    byteLength += chunk.byteLength;
    if (byteLength > MAX_SKILL_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    next = await reader.read();
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

function parseBoundedSkillBody(encodedBody: string): SkillCreateShape | null {
  try {
    const body = JSON.parse(encodedBody) as unknown;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    return body as SkillCreateShape;
  } catch { return null; }
}

function validateSkillCreate(body: SkillCreateShape): { error: string } | ValidatedSkillCreate {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'invalid skill body' };
  }
  if (Object.keys(body).some((field) => !['description', 'instructions', 'source', 'scope'].includes(field))) {
    return { error: 'unsupported skill body field' };
  }
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  if (description === '' || description.length > 500 || /\r?\n/u.test(description)) {
    return { error: 'a description of 1-500 characters is required' };
  }
  const instructions = body.instructions;
  if (typeof instructions !== 'string' || instructions === ''
    || Buffer.byteLength(instructions, 'utf8') > MAX_INSTRUCTIONS_BYTES) {
    return { error: 'instructions must be text within 512 KiB' };
  }
  if (body.source !== undefined && body.source !== 'opencode') {
    return { error: 'only managed opencode skills can be created' };
  }
  const scope = body.scope === undefined || body.scope === 'project' ? 'project' : body.scope;
  if (scope !== 'user' && scope !== 'project') return { error: 'scope must be either user or project' };
  return { description, instructions, scope };
}

function canonicalProjectCheckout(raw: string): string | null {
  try {
    const checkout = realpathSync(raw);
    if (!statSync(checkout, { throwIfNoEntry: false })?.isDirectory()) return null;
    return checkout;
  } catch { return null; }
}

function managedSkillRoot(scope: 'user' | 'project', projectCheckout: string | null): string {
  const userConfigRoot = directAbsolute(process.env.OPENCODE_CONFIG_DIR) ?? join(homedir(), '.opencode');
  return scope === 'user'
    ? join(userConfigRoot, 'skills')
    : join(projectCheckout ?? '', '.opencode', 'skills');
}

function writeManagedSkill(target: string, content: string): 'created' | 'exists' | 'failed' {
  let temporary: string | null = null;
  try {
    mkdirSync(join(target, '..'), { recursive: true });
    if (statSync(target, { throwIfNoEntry: false })) return 'exists';
    temporary = join(target, '..', `SKILL.tmp-${randomUUID()}`);
    writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx' });
    try { linkSync(temporary, target); }
    catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'EEXIST') return 'exists';
      throw error;
    }
    temporary = null;
    return 'created';
  } catch { return 'failed'; }
  finally {
    if (temporary) { try { unlinkSync(temporary); } catch { /* response already resolved */ } }
  }
}

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
  app.post('/api/config/skills/:name', async (c) => {
    const name = c.req.param('name');
    if (!SKILL_NAME.test(name) || name.length > 64) {
      return c.json({ error: 'invalid skill name' }, 400);
    }
    const encodedBody = await readBoundedSkillBody(c.req.raw);
    if (encodedBody === null) return c.json({ error: 'invalid skill body' }, 400);
    const body = parseBoundedSkillBody(encodedBody);
    if (!body) return c.json({ error: 'invalid skill body' }, 400);
    const validated = validateSkillCreate(body);
    if ('error' in validated) return c.json({ error: validated.error }, 400);
    const requestedDirectory = c.req.query('directory') ?? '';
    if ((validated.scope === 'project' || requestedDirectory !== '')
      && !/^([A-Za-z]:)?[\\/]/u.test(requestedDirectory)) {
      return c.json({ error: 'a project checkout directory is required' }, 400);
    }
    const checkout = canonicalProjectCheckout(requestedDirectory);
    if (validated.scope === 'project' && checkout === null) {
      return c.json({ error: 'project checkout directory is required' }, 400);
    }
    const managedRoot = managedSkillRoot(validated.scope, checkout);
    const target = join(managedRoot, name, 'SKILL.md');
    const conflictDirectory = validated.scope === 'user' ? homedir() : requestedDirectory;
    const existing = scanLocalSkills(conflictDirectory).find((skill) => skill.name === name);
    if (existing) return c.json({ error: 'a different skill already owns this name' }, 409);
    const content = `---\nname: ${name}\ndescription: ${validated.description}\n---\n\n${validated.instructions}`;
    const outcome = writeManagedSkill(target, content);
    if (outcome === 'exists') return c.json({ error: 'skill already exists' }, 409);
    if (outcome === 'failed') return c.json({ error: 'managed skill storage failed' }, 500);
    return c.json({
      requiresReload: true,
      message: 'skill created; reload before use',
      reloadDelayMs: 500,
    }, 201);
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
