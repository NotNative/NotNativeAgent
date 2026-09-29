// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
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

  it('scans OpenCode config roots and legacy plus plural layouts', () => {
    const config = mkdtempSync(join(tmpdir(), 'nnd-p10-skills-opencode-'));
    const project = mkdtempSync(join(tmpdir(), 'nnd-p10-skills-openproject-'));
    const directories = [
      join(config, 'skill', 'user-legacy'),
      join(config, 'skills', 'user-current'),
      join(project, '.opencode', 'skill', 'project-legacy'),
      join(project, '.opencode', 'skills', 'project-current'),
    ];
    const names = ['user-legacy', 'user-current', 'project-legacy', 'project-current'];
    names.forEach((name, index) => {
      mkdirSync(directories[index]!, { recursive: true });
      writeFileSync(join(directories[index]!, 'SKILL.md'),
        `---\nname: ${name}\ndescription: ${name} checked\n---`);
    });
    process.env.OPENCODE_CONFIG_DIR = config;
    try {
      const skills = scanLocalSkills(project);
      const byName = new Map(skills.map((skill) => [skill.name, skill]));
      expect([...byName.keys()]).toEqual(expect.arrayContaining(names));
      expect(byName.get('user-current')).toMatchObject({
        scope: 'user', source: 'opencode', description: 'user-current checked',
      });
      expect(byName.get('project-current')).toMatchObject({
        scope: 'project', source: 'opencode', description: 'project-current checked',
      });
    } finally {
      delete process.env.OPENCODE_CONFIG_DIR;
      rmSync(config, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('scans OpenCode cache roots when the cache home is absolute', () => {
    const cache = mkdtempSync(join(process.cwd(), '.tmp-nnd-p10-skills-cache-'));
    const skill = join(cache, 'opencode', 'skills', 'cached-flow');
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, 'SKILL.md'), '---\nname: cached-flow\ndescription: cached flow checked\n---');
    try {
      process.env.XDG_CACHE_HOME = relative(process.cwd(), cache);
      expect(scanLocalSkills(checkout).find((entry) => entry.name === 'cached-flow')).toBeUndefined();
      process.env.XDG_CACHE_HOME = cache;
      expect(scanLocalSkills(checkout).find((entry) => entry.name === 'cached-flow'))
        .toMatchObject({ scope: 'user', source: 'opencode', description: 'cached flow checked' });
    } finally {
      delete process.env.XDG_CACHE_HOME;
      rmSync(cache, { recursive: true, force: true });
    }
  });

  it('adds configured skills.paths outside the project and ignores unsafe values', () => {
    const extra = mkdtempSync(join(tmpdir(), 'nnd-p10-skills-config-path-'));
    const project = mkdtempSync(join(tmpdir(), 'nnd-p10-skills-config-proj-'));
    const skill = join(extra, 'extra-flow');
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, 'SKILL.md'), '---\nname: extra-flow\ndescription: extra flow checked\n---');
    mkdirSync(join(project, '.opencode'), { recursive: true });
    writeFileSync(join(project, '.opencode', 'opencode.json'), JSON.stringify({
      skills: { paths: [extra, 'relative-skill', 'C:'] },
    }));
    try {
      const found = scanLocalSkills(project).find((entry) => entry.name === 'extra-flow');
      expect(found).toMatchObject({
        scope: 'project', source: 'opencode', description: 'extra flow checked',
      });
      expect(found?.path.startsWith(extra)).toBe(true);
    } finally {
      rmSync(extra, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('deduplicates exact config roots before the item cap', () => {
    const home = mkdtempSync(join(tmpdir(), 'nnd-p10-skills-home-'));
    const configRoot = join(home, 'shared', 'opencode');
    const project = mkdtempSync(join(tmpdir(), 'nnd-p10-skills-dedupe-proj-'));
    const duplicatedSkillRoot = join(configRoot, 'skill');
    mkdirSync(project, { recursive: true });
    mkdirSync(duplicatedSkillRoot, { recursive: true });
    Array.from({ length: 198 }, (_, index) => {
      const skill = join(duplicatedSkillRoot, `duplicate-${index}`);
      mkdirSync(skill, { recursive: true });
      writeFileSync(join(skill, 'SKILL.md'), `---\nname: duplicate-${index}\ndescription: duplicate\n---`);
    });
    const projectSkill = join(project, '.opencode', 'skills', 'project-final');
    mkdirSync(projectSkill, { recursive: true });
    writeFileSync(join(projectSkill, 'SKILL.md'), '---\nname: project-final\ndescription: final checked\n---');
    const previousHome = process.env.HOME;
    const previousUserHome = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.OPENCODE_CONFIG_DIR = configRoot;
    process.env.XDG_CONFIG_HOME = join(home, 'shared');
    try {
      expect(scanLocalSkills(project).some((entry) => entry.name === 'project-final')).toBe(true);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserHome === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserHome;
      delete process.env.OPENCODE_CONFIG_DIR;
      delete process.env.XDG_CONFIG_HOME;
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('ignores an oversized project skill config', () => {
    const extra = mkdtempSync(join(tmpdir(), 'nnd-p10-skills-large-config-extra-'));
    const project = mkdtempSync(join(tmpdir(), 'nnd-p10-skills-large-config-proj-'));
    const skill = join(extra, 'oversize-flow');
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, 'SKILL.md'), '---\nname: oversize-flow\ndescription: oversize\n---');
    mkdirSync(join(project, '.opencode'), { recursive: true });
    writeFileSync(join(project, '.opencode', 'opencode.json'),
      `${JSON.stringify({ skills: { paths: [extra] } })}${' '.repeat(1_048_577)}`);
    try {
      expect(scanLocalSkills(project).some((entry) => entry.name === 'oversize-flow')).toBe(false);
    } finally {
      rmSync(extra, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('creates a managed project skill at the OpenCode roots and returns restart deference', async () => {
    const project = mkdtempSync(join(tmpdir(), 'nnd-p10-skill-create-'));
    const create = await app().request(`/api/config/skills/drafted-flow?directory=${encodeURIComponent(project)}`, {
      method: 'POST',
      body: JSON.stringify({
        description: 'Drafted flow',
        instructions: 'Run drafted checks.',
      }),
    });
    expect(create.status).toBe(201);
    expect(await create.json()).toEqual({
      requiresReload: true,
      message: 'skill created; reload before use',
      reloadDelayMs: 500,
    });
    const skill = scanLocalSkills(project).find((entry) => entry.name === 'drafted-flow');
    expect(skill).toMatchObject({
      name: 'drafted-flow', description: 'Drafted flow', scope: 'project',
      source: 'opencode', renamable: true,
    });
    const duplicate = await app().request(`/api/config/skills/drafted-flow?directory=${encodeURIComponent(project)}`, {
      method: 'POST',
        body: JSON.stringify({ description: 'again', instructions: 'again' }),
    });
    expect(duplicate.status).toBe(409);
    rmSync(project, { recursive: true, force: true });
  });

  it('rejects empty instructions and frontmatter-rewriting descriptions', async () => {
    for (const body of [
      { description: 'Ready', instructions: '' },
      { description: 'Line\nname: hostile' },
    ]) {
      const response = await app().request('/api/config/skills/rejected-flow?directory=/', {
        method: 'POST', body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }
  });

  it('rejects a project checkout that resolves to a file', async () => {
    const project = mkdtempSync(join(tmpdir(), 'nnd-p10-skill-file-checkout-'));
    const file = join(project, 'checkout');
    writeFileSync(file, 'not a checkout');
    try {
      const response = await app().request(
        `/api/config/skills/file-checkout?directory=${encodeURIComponent(file)}`, {
          method: 'POST',
          body: JSON.stringify({ description: 'file', instructions: 'file' }),
        });
      expect(response.status).toBe(400);
      expect(existsSync(join(project, '.opencode', 'skills', 'file-checkout', 'SKILL.md'))).toBe(false);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('rejects supporting files through symlinks before mutating storage', async () => {
    const project = mkdtempSync(join(tmpdir(), 'nnd-p10-skill-file-symlink-'));
    const skill = join(project, '.opencode', 'skills', 'linked-flow');
    const directory = encodeURIComponent(project);
    const previousAllDisabled = process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS;
    const previousClaudeSkills = process.env.OPENCODE_DISABLE_CLAUDE_SKILLS;
    const previousClaudeCode = process.env.OPENCODE_DISABLE_CLAUDE_CODE;
    process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = '1';
    mkdirSync(join(skill, '..'), { recursive: true });
    mkdirSync(join(project, 'source'), { recursive: true });
    mkdirSync(join(skill, 'asset', 'linked'), { recursive: true });
    writeFileSync(join(skill, 'SKILL.md'), '---\nname: linked-flow\ndescription: Linked\n---');
    rmSync(join(skill, 'asset', 'linked'), { recursive: true, force: true });
    symlinkSync(join(project, 'source'), join(skill, 'asset', 'linked'), 'junction');
    try {
      const response = await app().request(
        `/api/config/skills/linked-flow/files/asset/linked/inside.txt?directory=${directory}`, {
          method: 'PUT', body: 'outside',
        });
      expect(response.status).toBe(400);
      expect(existsSync(join(project, 'source', 'inside.txt'))).toBe(false);
      expect(existsSync(join(project, 'inside.txt'))).toBe(false);
      const nestedResponse = await app().request(
        `/api/config/skills/linked-flow/files/asset/linked/nested/inside.txt?directory=${directory}`, {
          method: 'PUT', body: 'outside',
        });
      expect(nestedResponse.status).toBe(400);
      expect(existsSync(join(project, 'source', 'nested'))).toBe(false);
    } finally {
      unlinkSync(join(skill, 'asset', 'linked'));
      if (previousAllDisabled === undefined) delete process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS;
      else process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = previousAllDisabled;
      if (previousClaudeSkills === undefined) delete process.env.OPENCODE_DISABLE_CLAUDE_SKILLS;
      else process.env.OPENCODE_DISABLE_CLAUDE_SKILLS = previousClaudeSkills;
      if (previousClaudeCode === undefined) delete process.env.OPENCODE_DISABLE_CLAUDE_CODE;
      else process.env.OPENCODE_DISABLE_CLAUDE_CODE = previousClaudeCode;
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('rejects create payloads with unsupported supporting files', async () => {
    const response = await app().request('/api/config/skills/unsupported-files?directory=/', {
      method: 'POST',
      body: JSON.stringify({
        description: 'unsupported', instructions: 'unsupported', supportingFiles: [],
      }),
    });
    expect(response.status).toBe(400);
    expect(existsSync(join('/', '.opencode', 'skills', 'unsupported-files', 'SKILL.md'))).toBe(false);
  });

  it('reads, writes, and deletes managed supporting files', async () => {
    const project = mkdtempSync(join(tmpdir(), 'nnd-p10-skill-files-'));
    const skill = join(project, '.opencode', 'skills', 'supported-flow');
    const path = `/api/config/skills/supported-flow/files/support.txt?directory=${encodeURIComponent(project)}`;
    await app().request('/api/config/skills/supported-flow?directory=' + encodeURIComponent(project), {
      method: 'POST', body: JSON.stringify({ description: 'Supported', instructions: 'Supported.' }),
    });
    const created = await app().request(path, {
      method: 'PUT', body: 'supporting content',
    });
    expect(created.status).toBe(201);
    expect(readFileSync(join(skill, 'support.txt'), 'utf8')).toBe('supporting content');
    const read = await app().request(path);
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ path: 'support.txt', content: 'supporting content' });
    const deleted = await app().request(path, { method: 'DELETE' });
    expect(deleted.status).toBe(201);
    expect(existsSync(join(skill, 'support.txt'))).toBe(false);
    rmSync(skill, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  it('allows nested supporting paths and rejects protected or escaping paths', async () => {
    const project = mkdtempSync(join(tmpdir(), 'nnd-p10-skill-file-guards-'));
    const skill = join(project, '.opencode', 'skills', 'guarded-flow');
    const directory = encodeURIComponent(project);
    await app().request(`/api/config/skills/guarded-flow?directory=${directory}`, {
      method: 'POST', body: JSON.stringify({ description: 'Guarded', instructions: 'Guarded.' }),
    });
    const nestedResponse = await app().request(
      `/api/config/skills/guarded-flow/files/nested%2Fcheck.txt?directory=${directory}`, {
        method: 'PUT', body: 'nested content',
      });
    expect(nestedResponse.status).toBe(201);
    expect(readFileSync(join(skill, 'nested', 'check.txt'), 'utf8')).toBe('nested content');
    for (const filePath of [
      'SKILL.md',
      'nested/SKILL.md',
      'C:%5Coutside.txt',
    ]) {
      const response = await app().request(
        `/api/config/skills/guarded-flow/files/${filePath}?directory=${directory}`, {
          method: 'PUT', body: 'forbidden',
        });
      expect(response.status).toBe(400);
    }
    expect(existsSync(join(skill, 'SKILL.md'))).toBe(true);
    expect(existsSync(join(skill, 'nested', 'check.txt'))).toBe(true);
    rmSync(project, { recursive: true, force: true });
  });

  it('rejects create requests beyond the bounded wire body', async () => {
    const response = await app().request('/api/config/skills/wire-bound?directory=/', {
      method: 'POST', body: 'x'.repeat(2 * 1024 * 1024 + 1),
    });
    expect(response.status).toBe(400);
  });

  it('uses the fallback OpenCode config root for drive-relative user roots', async () => {
    const home = mkdtempSync(join(tmpdir(), 'nnd-p10-skill-user-root-'));
    const previousHome = process.env.HOME;
    const previousUserHome = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.OPENCODE_CONFIG_DIR = 'C:';
    try {
      const create = await app().request('/api/config/skills/drive-relative-user', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope: 'user', description: 'fallback', instructions: 'fallback' }),
      });
      expect(create.status).toBe(201);
      expect(existsSync(join(home, '.opencode', 'skills', 'drive-relative-user', 'SKILL.md'))).toBe(true);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserHome === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserHome;
      delete process.env.OPENCODE_CONFIG_DIR;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('creates a managed user skill in the configured OpenCode root', async () => {
    const config = mkdtempSync(join(tmpdir(), 'nnd-p10-skill-user-'));
    process.env.OPENCODE_CONFIG_DIR = config;
    try {
      const create = await app().request('/api/config/skills/user-flow', {
        method: 'POST',
      headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          scope: 'user', description: 'user flow', instructions: 'Keep it clear.',
        }),
      });
      expect(create.status).toBe(201);
      expect(scanLocalSkills(homedir()).find((entry) => entry.name === 'user-flow'))
        .toMatchObject({ scope: 'user', source: 'opencode', renamable: true });
    } finally {
      delete process.env.OPENCODE_CONFIG_DIR;
      rmSync(config, { recursive: true, force: true });
    }
  });

  it('updates and renames a managed OpenCode skill', async () => {
    const project = mkdtempSync(join(tmpdir(), 'nnd-p10-skill-patch-'));
    const name = 'drafted-flow';
    await app().request(`/api/config/skills/${name}?directory=${encodeURIComponent(project)}`, {
      method: 'POST',
      body: JSON.stringify({ description: 'Drafted flow', instructions: 'Run drafted checks.' }),
    });
    const update = await app().request(`/api/config/skills/${name}?directory=${encodeURIComponent(project)}`, {
      method: 'PATCH',
      body: JSON.stringify({ description: 'Revised flow', instructions: 'Run revised checks.' }),
    });
    expect(update.status).toBe(201);
    expect(await update.json()).toEqual({
      requiresReload: true, message: 'skill updated; reload before use', reloadDelayMs: 500,
    });
    const skill = scanLocalSkills(project).find((entry) => entry.name === name);
    expect(skill).toMatchObject({ description: 'Revised flow', renamable: true });
    const rename = await app().request(`/api/config/skills/${name}?directory=${encodeURIComponent(project)}`, {
      method: 'PATCH',
      body: JSON.stringify({ renameTo: 'revised-flow' }),
    });
    expect(rename.status).toBe(201);
    expect(await rename.json()).toMatchObject({ requiresReload: true, message: 'skill renamed; reload before use' });
    const names = scanLocalSkills(project).map((entry) => entry.name);
    expect(names).toContain('revised-flow');
    expect(names).not.toContain(name);
    rmSync(project, { recursive: true, force: true });
  });

  it('keeps project routes scoped to the requested checkout', async () => {
    const config = mkdtempSync(join(tmpdir(), 'nnd-p10-skill-cross-'));
    const project = mkdtempSync(join(tmpdir(), 'nnd-p10-skill-project-'));
    const userDirectory = join(config, 'skills', 'cross-scope');
    mkdirSync(userDirectory, { recursive: true });
    writeFileSync(join(userDirectory, 'SKILL.md'),
      '---\nname: cross-scope\ndescription: User skill\n---');
    process.env.OPENCODE_CONFIG_DIR = config;
    try {
      const response = await app().request(`/api/config/skills/cross-scope?directory=${encodeURIComponent(project)}`, {
        method: 'PATCH',
        body: JSON.stringify({ description: 'Project', instructions: 'Boom.' }),
      });
      expect(response.status).toBe(404);
      expect(readFileSync(join(userDirectory, 'SKILL.md'), 'utf8')).toContain('User skill');
      expect(existsSync(join(project, '.opencode', 'skills'))).toBe(false);
    } finally {
      delete process.env.OPENCODE_CONFIG_DIR;
      rmSync(config, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('rejects a rename mixed with content edits', async () => {
    const project = mkdtempSync(join(tmpdir(), 'nnd-p10-skill-mixed-'));
    const directory = join(project, '.opencode', 'skills', 'mixed-patch');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'SKILL.md'),
      '---\nname: mixed-patch\ndescription: Original\n---');
    const response = await app().request(`/api/config/skills/mixed-patch?directory=${encodeURIComponent(project)}`, {
      method: 'PATCH',
      body: JSON.stringify({ renameTo: 'renamed-patch', description: 'Later', instructions: 'Boom.' }),
    });
    expect(response.status).toBe(400);
    expect(existsSync(join(directory, 'SKILL.md'))).toBe(true);
    expect(existsSync(join(project, '.opencode', 'skills', 'renamed-patch'))).toBe(false);
    rmSync(project, { recursive: true, force: true });
  });

  it('rejects a relative project checkout for patching', async () => {
    const response = await app().request('/api/config/skills/relative-checkout?directory=relative', {
      method: 'PATCH',
      body: JSON.stringify({ renameTo: 'renamed-checkout' }),
    });
    expect(response.status).toBe(400);
  });

  it('rejects a relative project checkout for deleting', async () => {
    const response = await app().request('/api/config/skills/relative-checkout?directory=relative', {
      method: 'DELETE',
    });
    expect(response.status).toBe(400);
  });

  it('renames only the opening frontmatter name', async () => {
    const project = mkdtempSync(join(tmpdir(), 'nnd-p10-skill-frontmatter-'));
    const directory = join(project, '.opencode', 'skills', 'frontmatter-flow');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'SKILL.md'),
      '---\nname: frontmatter-flow\ndescription: Original\n---\n\nname: body-name\n');
    const response = await app().request(`/api/config/skills/frontmatter-flow?directory=${encodeURIComponent(project)}`, {
      method: 'PATCH',
      body: JSON.stringify({ renameTo: 'renamed-frontmatter' }),
    });
    expect(response.status).toBe(201);
    const content = readFileSync(join(project, '.opencode', 'skills', 'renamed-frontmatter', 'SKILL.md'), 'utf8');
    expect(content).toContain('name: renamed-frontmatter');
    expect(content).toContain('name: body-name');
    rmSync(project, { recursive: true, force: true });
  });

  it('deletes a managed project skill once', async () => {
    const project = mkdtempSync(join(tmpdir(), 'nnd-p10-skill-delete-'));
    await app().request(`/api/config/skills/removable-flow?directory=${encodeURIComponent(project)}`, {
      method: 'POST',
      body: JSON.stringify({ description: 'Removable flow', instructions: 'Then remove.' }),
    });
    const deleted = await app().request(`/api/config/skills/removable-flow?directory=${encodeURIComponent(project)}`, {
      method: 'DELETE',
    });
    expect(deleted.status).toBe(201);
    expect(await deleted.json()).toEqual({
      requiresReload: true, message: 'skill deleted; reload before use', reloadDelayMs: 500,
    });
    expect(scanLocalSkills(project).some((skill) => skill.name === 'removable-flow')).toBe(false);
    const again = await app().request(`/api/config/skills/removable-flow?directory=${encodeURIComponent(project)}`, {
      method: 'DELETE',
    });
    expect(again.status).toBe(404);
    rmSync(project, { recursive: true, force: true });
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
