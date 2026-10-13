// SPDX-License-Identifier: Apache-2.0
import type { Context, Hono } from 'hono';
import { deleteSkillSupportingFile, readBoundedSkillBody, readSkillSupportingFile, writeSkillSupportingFile } from './skill-support.ts';
import { linkSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { catalogDocument, catalogSources } from '../lib/skills/skill-catalog.ts';
import { scanCatalogSourceCached } from '../lib/skills/skill-catalog-cache.ts';
import { SkillInstallError, catalogConflicts, installSelectedSkills } from '../lib/skills/skill-catalog-installer.ts';
import type { CatalogScanItem } from '../lib/skills/skill-catalog-scan.ts';
import { directAbsolute, externalSkillFlags, scanLocalSkills } from '../lib/skills/skill-scan.ts';
import {
  catalogScanBody, catalogScanFailure, parseBoundedSkillBody, scanAdHocCatalog, skillNameValid, SKILL_NAME,
  type SkillCreateShape,
} from './skill-catalog-common.ts';
import { installCatalog } from './skill-catalog-install-route.ts';

const MAX_INSTRUCTIONS_BYTES = 512 * 1024;
const MAX_SKILL_BODY_BYTES = 2 * 1024 * 1024;

type DiscoveredSkill = ReturnType<typeof scanLocalSkills>[number];

function absoluteLike(value: string): boolean {
  return /^([A-Za-z]:)?[\\/]/u.test(value);
}

interface ValidatedSkillCreate {
  description: string; instructions: string; scope: 'user' | 'project';
}

interface ValidatedSkillPatch {
  description: string; instructions: string;
}

type ConflictPolicy = 'prompt' | 'skipAll' | 'overwriteAll';

type TargetSource = 'opencode' | 'agents';

interface ValidatedSkillInstall {
  source: string; subpath: string | null; gitIdentityId: string | null;
  scope: 'user' | 'project'; targetSource: TargetSource;
  selections: string[]; conflictPolicy: ConflictPolicy;
  conflictDecisions: Record<string, 'skip' | 'overwrite'>;
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

export function canonicalProjectCheckout(raw: string): string | null {
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

function validateSkillPatch(body: SkillCreateShape): { error: string } | ValidatedSkillPatch {
  const allowed = ['description', 'instructions', 'renameTo'];
  if (Object.keys(body).some((field) => !allowed.includes(field))) {
    return { error: 'unsupported skill patch field' };
  }
  if (body.description === undefined && body.instructions === undefined) {
    return { error: 'description or instructions is required' };
  }
  const description = body.description === undefined ? '' : body.description;
  if (typeof description !== 'string' || description.trim() === ''
    || description.trim().length > 500 || /\r?\n/u.test(description.trim())) {
    return { error: 'a one-line description of 1-500 characters is required' };
  }
  const instructions = body.instructions === undefined ? '' : body.instructions;
  if (typeof instructions !== 'string' || instructions.length === 0
    || Buffer.byteLength(instructions, 'utf8') > MAX_INSTRUCTIONS_BYTES) {
    return { error: 'nonempty instructions within 512 KiB are required' };
  }
  return { description: description.trim(), instructions };
}

function renameSkillFrontmatter(content: string, target: string): string | null {
  const opening = /^(?:\ufeff)?---\r?\n/u.exec(content);
  if (!opening) return null;
  const body = content.slice(opening[0].length);
  const closing = /\r?\n---(?:\r?\n|$)/u.exec(body);
  if (!closing) return null;
  const metadata = body.slice(0, closing.index).replace(/^name:\s*(.+)$/mu, `name: ${target}`);
  if (!/^name:\s*/u.test(metadata)) return null;
  const rest = body.slice(closing.index);
  return `${opening[0]}${metadata}${rest}`;
}

function skillEditable(skill: ReturnType<typeof scanLocalSkills>[number] | undefined): boolean {
  return skill?.renamable === true && skill.source === 'opencode';
}

function renameSkillFile(source: string, target: string): 'renamed' | 'conflict' | 'failed' {
  try {
    mkdirSync(join(target, '..'), { recursive: true });
    try { linkSync(source, target); }
    catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code !== 'EEXIST') return 'failed';
      return 'conflict';
    }
    unlinkSync(source);
    return 'renamed';
  } catch { return 'failed'; }
}

function replaceSkillFile(target: string, content: string): 'committed' | 'conflict' | 'failed' {
  let temporary: string | null = null;
  try {
    temporary = join(target, '..', `SKILL.tmp-${randomUUID()}`);
    writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx' });
    try {
      unlinkSync(target);
      linkSync(temporary, target);
      return 'committed';
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'EEXIST') return 'conflict';
      throw error;
    }
  } catch { return 'failed'; }
  finally {
    if (temporary) { try { unlinkSync(temporary); } catch { /* response already resolved */ } }
  }
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

type SkillPatchRequest = { error: string } | { rename: string | null };

function readSkillPatch(parse: SkillCreateShape, name: string): SkillPatchRequest {
  const rename = typeof parse.renameTo === 'string' ? parse.renameTo : null;
  if (parse.renameTo === undefined)
    return { rename: null };
  if (rename === null || !SKILL_NAME.test(rename) || rename.length > 64)
    return { error: 'invalid rename target' };
  if (!Object.keys(parse).every((field) => field === 'renameTo'))
    return { error: 'renameTo must be the only patch field' };
  if (rename === name)
    return { error: 'rename target matches current name' };
  return { rename };
}

async function applySkillPatch(context: Context, name: string, parse: SkillCreateShape,
  requestedDirectory: string, request: { rename: string | null }): Promise<Response> {
  const searchDirectory = requestedDirectory === '' ? homedir() : requestedDirectory;
  const scope = requestedDirectory === '' ? 'user' : 'project';
  const skill = scanLocalSkills(searchDirectory)
    .find((entry) => entry.name === name && entry.scope === scope);
  if (!skill) return context.json({ error: 'skill not found' }, 404);
  if (!skillEditable(skill)) return context.json({ error: 'skill is not managed here' }, 403);
  if (request.rename !== null) return renameManagedSkill(context, skill.path, request.rename);
  const validated = validateSkillPatch(parse);
  if ('error' in validated) return context.json({ error: validated.error }, 400);
  const content = `---\nname: ${name}\ndescription: ${validated.description}\n---\n\n${validated.instructions}`;
  if (replaceSkillFile(skill.path, content) === 'failed') {
    return context.json({ error: 'managed skill storage failed' }, 500);
  }
  return context.json({
    requiresReload: true, message: 'skill updated; reload before use', reloadDelayMs: 500,
  }, 201);
}

async function renameManagedSkill(context: Context, source: string, rename: string): Promise<Response> {
  const directory = join(source, '..');
  const renamedContent = renameSkillFrontmatter(readFileSync(source, 'utf8'), rename);
  if (renamedContent === null) return context.json({ error: 'managed skill rename failed' }, 500);
  const target = join(directory, '..', rename, 'SKILL.md');
  const temporary = join(directory, `SKILL.tmp-${randomUUID()}`);
  try {
    writeFileSync(temporary, renamedContent, { encoding: 'utf8', flag: 'wx' });
    const renamed = renameSkillFile(temporary, target);
    if (renamed === 'failed') return context.json({ error: 'managed skill storage failed' }, 500);
    if (renamed === 'conflict') return context.json({ error: 'skill already exists' }, 409);
    unlinkSync(source);
    return context.json({
      requiresReload: true, message: 'skill renamed; reload before use', reloadDelayMs: 500,
    }, 201);
  } catch { return context.json({ error: 'managed skill storage failed' }, 500); }
  finally { try { unlinkSync(temporary); } catch { /* response already resolved */ } }
}

async function deleteSkillInScope(context: Context, name: string,
  requestedDirectory: string): Promise<Response> {
  const scope = requestedDirectory === '' ? 'user' : 'project';
  const searchDirectory = requestedDirectory === '' ? homedir() : requestedDirectory;
  const skill = scanLocalSkills(searchDirectory)
    .find((entry) => entry.name === name && entry.scope === scope);
  if (!skill) return context.json({ error: 'skill not found' }, 404);
  if (!skillEditable(skill)) return context.json({ error: 'skill is not managed here' }, 403);
  try {
    rmSync(join(skill.path, '..'), { recursive: true, force: false });
    return context.json({
      requiresReload: true, message: 'skill deleted; reload before use', reloadDelayMs: 500,
    }, 201);
  } catch {
    return context.json({ error: 'managed skill storage failed' }, 500);
  }
}

function resolveManagedSkill(name: string, requestedDirectory: string): DiscoveredSkill | undefined {
  const scope = requestedDirectory === '' ? 'user' : 'project';
  const searchDirectory = requestedDirectory === '' ? homedir() : requestedDirectory;
  return scanLocalSkills(searchDirectory)
    .find((entry) => entry.name === name && entry.scope === scope);
}

async function createManagedSkill(context: Context, name: string, body: SkillCreateShape,
  requestedDirectory: string): Promise<Response> {
  const validated = validateSkillCreate(body);
  if ('error' in validated) return context.json({ error: validated.error }, 400);
  const checkout = canonicalProjectCheckout(requestedDirectory);
  if (validated.scope === 'project' && checkout === null) {
    return context.json({ error: 'project checkout directory is required' }, 400);
  }
  const target = join(managedSkillRoot(validated.scope, checkout), name, 'SKILL.md');
  const conflictDirectory = validated.scope === 'user' ? homedir() : requestedDirectory;
  const exists = scanLocalSkills(conflictDirectory).some((skill) => skill.name === name);
  if (exists) return context.json({ error: 'a different skill already owns this name' }, 409);
  const content = `---\nname: ${name}\ndescription: ${validated.description}\n---\n\n${validated.instructions}`;
  const outcome = writeManagedSkill(target, content);
  if (outcome === 'exists') return context.json({ error: 'skill already exists' }, 409);
  if (outcome === 'failed') return context.json({ error: 'managed skill storage failed' }, 500);
  return context.json({
    requiresReload: true, message: 'skill created; reload before use', reloadDelayMs: 500,
  }, 201);
}

function registerSkillListRoutes(app: Hono): void {
  app.get('/api/config/skills', (c) => {
    try {
      const externalSkills = externalSkillFlags();
      return c.json({
        skills: scanLocalSkills(c.req.query('directory') ?? ''),
        externalSkills,
      });
    } catch { return c.json({ error: 'project checkout directory is required' }, 400); }
  });
  app.get('/api/skills/catalog/sources', (c) => c.json({ sources: catalogSources() }));
  app.get('/api/config/skills/catalog', async (c) => c.json({
    ok: true,
    ...(await catalogDocument()),
  }));
  app.get('/api/config/skills/catalog/source', async (c) => {
    const refresh = c.req.query('refresh');
    if (refresh !== undefined && refresh !== 'true') {
      return c.json({ error: { kind: 'invalidSource', message: 'invalid refresh flag' } }, 400);
    }
    const directory = c.req.query('directory') ?? '';
    return scanCatalogSourceById(c, directory === '' ? undefined : directory, c.req.query('sourceId') ?? '');
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

async function scanCatalogSourceById(context: Context, directory: string | undefined,
  sourceId: string): Promise<Response> {
  const source = catalogSources().find((entry) => entry.id === sourceId);
  if (!source) {
    return context.json({ error: { kind: 'invalidSource', message: 'unknown skill catalog source' } }, 400);
  }
  try {
    const curated = 'defaultSubpath' in source;
    const items = await scanCatalogSourceCached({
      source: source.source,
      subpath: curated ? source.defaultSubpath : source.subpath,
      directory,
      gitIdentityId: curated ? null : source.gitIdentityId,
    }, context.req.query('refresh') === 'true');
    return context.json({ ok: true, source, sourceId, items });
  } catch (error) { return catalogScanFailure(context, error); }
}

function registerManagedSkillRoutes(app: Hono): void {
  app.post('/api/config/skills/scan', async (c) => {
    const directory = c.req.query('directory') ?? '';
    return scanAdHocCatalog(c, directory === '' ? undefined : directory);
  });
  app.post('/api/config/skills/install', async (c) => {
    return installCatalog(c, c.req.query('directory') ?? '');
  });
  app.post('/api/config/skills/:name', async (c) => {
    const name = c.req.param('name');
    if (!skillNameValid(name)) {
      return c.json({ error: 'invalid skill name' }, 400);
    }
    const encodedBody = await readBoundedSkillBody(c.req.raw);
    if (encodedBody === null) return c.json({ error: 'invalid skill body' }, 400);
    const body = parseBoundedSkillBody(encodedBody);
    if (!body) return c.json({ error: 'invalid skill body' }, 400);
    const requestedDirectory = c.req.query('directory') ?? '';
    return createManagedSkill(c, name, body, requestedDirectory);
  });
  app.patch('/api/config/skills/:name', async (c) => {
    const name = c.req.param('name');
    if (!skillNameValid(name)) return c.json({ error: 'invalid skill name' }, 400);
    const encodedBody = await readBoundedSkillBody(c.req.raw);
    if (encodedBody === null) return c.json({ error: 'invalid skill body' }, 400);
    const parse = parseBoundedSkillBody(encodedBody);
    if (!parse) return c.json({ error: 'invalid skill body' }, 400);
    const request = readSkillPatch(parse, name);
    if ('error' in request) return c.json({ error: request.error }, 400);
    const requestedDirectory = c.req.query('directory') ?? '';
    if (requestedDirectory !== '' && !absoluteLike(requestedDirectory)) {
      return c.json({ error: 'project checkout directory is required' }, 400);
    }
    return applySkillPatch(c, name, parse, requestedDirectory, request);
  });
  app.delete('/api/config/skills/:name', async (c) => {
    const name = c.req.param('name');
    if (!skillNameValid(name)) return c.json({ error: 'invalid skill name' }, 400);
    const requestedDirectory = c.req.query('directory') ?? '';
    if (requestedDirectory !== '' && !absoluteLike(requestedDirectory)) {
      return c.json({ error: 'project checkout directory is required' }, 400);
    }
    return deleteSkillInScope(c, name, requestedDirectory);
  });
}

function registerSkillSupportRoutes(app: Hono): void {
  app.get('/api/config/skills/:name/files/*', (c) => {
    const requestedDirectory = c.req.query('directory') ?? '';
    if (requestedDirectory !== '' && !absoluteLike(requestedDirectory)) {
      return c.json({ error: 'project checkout directory is required' }, 400);
    }
    return readSkillSupportingFile(c, c.req.param('name') ?? '', requestedDirectory);
  });

  app.put('/api/config/skills/:name/files/*', async (c) => {
    const requestedDirectory = c.req.query('directory') ?? '';
    if (requestedDirectory !== '' && !absoluteLike(requestedDirectory)) {
      return c.json({ error: 'project checkout directory is required' }, 400);
    }
    const content = await readBoundedSkillBody(c.req.raw);
    if (content === null) return c.json({ error: 'invalid supporting file body' }, 400);
    return writeSkillSupportingFile(c, c.req.param('name') ?? '', content, requestedDirectory);
  });

  app.delete('/api/config/skills/:name/files/*', (c) => {
    const requestedDirectory = c.req.query('directory') ?? '';
    if (requestedDirectory !== '' && !absoluteLike(requestedDirectory)) {
      return c.json({ error: 'project checkout directory is required' }, 400);
    }
    return deleteSkillSupportingFile(c, c.req.param('name') ?? '', requestedDirectory);
  });
}

export function registerSkillRoutes(app: Hono): void {
  registerSkillListRoutes(app);
  registerManagedSkillRoutes(app);
  registerSkillSupportRoutes(app);
}
