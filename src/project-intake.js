// SPDX-License-Identifier: Apache-2.0
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

const GUIDANCE_FILES = Object.freeze(['README.md', 'README', 'NNA.md', 'AGENTS.md', 'CONTRIBUTING.md', 'SECURITY.md', 'LICENSE']);
const MANIFEST_FILES = Object.freeze(['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle']);
const ROOT_FILES = Object.freeze([...GUIDANCE_FILES, ...MANIFEST_FILES]);
const SOURCE_DIRECTORIES = ['src', 'lib', 'app', 'packages', 'apps', 'cmd', 'internal'];
const TEST_DIRECTORIES = ['test', 'tests', '__tests__', 'spec'];
const ENTRY_FILES = ['index.js', 'index.ts', 'main.js', 'main.ts', 'app.js', 'app.ts', 'cli.js', 'cli.ts'];
const MAX_DIRECTORY_ENTRIES = 256;
const MAX_PACKAGE_BYTES = 131_072;

export class ProjectIntake {
  constructor(workspaceRoot, options = {}) {
    this.root = resolve(workspaceRoot);
    this.telemetry = options.telemetry;
    this.maxDirectoryEntries = Number.isSafeInteger(options.maxDirectoryEntries) && options.maxDirectoryEntries > 0
      ? options.maxDirectoryEntries : MAX_DIRECTORY_ENTRIES;
  }

  async inspect() {
    const started = Date.now();
    try {
      const rootEntries = await boundedRootEntries(this.root, this.maxDirectoryEntries);
      const names = new Set(rootEntries.map((entry) => entry.name));
      const result = Object.freeze({
        workspace: this.root,
        repository: repositoryKind(names),
        guidance: ROOT_FILES.filter((name) => names.has(name) && guidanceFile(name)),
        manifests: ROOT_FILES.filter((name) => names.has(name) && manifestFile(name)),
        source_directories: SOURCE_DIRECTORIES.filter((name) => names.has(name)),
        test_directories: TEST_DIRECTORIES.filter((name) => names.has(name)),
        entry_points: await entryPoints(this.root, names),
        package: names.has('package.json') ? await packageFacts(this.root) : null,
        root_entries_examined: rootEntries.length,
        truncated: rootEntries.length >= this.maxDirectoryEntries,
      });
      this.telemetry?.record('project.intake', 'succeeded', summary(result), { durationMs: Date.now() - started });
      return result;
    } catch (error) {
      this.telemetry?.record('project.intake', 'failed', {
        code: error.code ?? 'project_intake_failed',
      }, { reasonCode: error.code, durationMs: Date.now() - started });
      return Object.freeze({
        workspace: this.root, repository: 'unknown', guidance: [], manifests: [],
        source_directories: [], test_directories: [], entry_points: [], package: null,
        root_entries_examined: 0, truncated: false, unavailable: error.code ?? 'project_intake_failed',
      });
    }
  }
}

export function shouldInspectProject(content) {
  return /\b(?:project|repo(?:sitory)?|codebase|workspace|working\s+(?:directory|folder)|current\s+(?:directory|folder))\b/iu.test(content);
}

async function boundedRootEntries(root, limit) {
  const entries = await readdir(root, { withFileTypes: true });
  return entries.sort((left, right) => left.name.localeCompare(right.name)).slice(0, limit);
}

function repositoryKind(names) {
  if (names.has('.git')) return 'git';
  if (names.has('.hg')) return 'mercurial';
  if (names.has('.svn')) return 'subversion';
  return 'none_detected';
}

function guidanceFile(name) {
  return GUIDANCE_FILES.includes(name);
}

function manifestFile(name) {
  return MANIFEST_FILES.includes(name);
}

async function entryPoints(root, names) {
  const found = ENTRY_FILES.filter((name) => names.has(name));
  const candidates = SOURCE_DIRECTORIES.filter((name) => names.has(name))
    .flatMap((directory) => ENTRY_FILES.map((name) => join(root, directory, name)));
  const present = await Promise.all(candidates.map(async (path) => await regularFile(path) ? path : null));
  for (const path of present.filter(Boolean)) {
    found.push(relative(root, path).replaceAll('\\', '/'));
  }
  return found.slice(0, 32);
}

async function packageFacts(root) {
  try {
    const path = join(root, 'package.json');
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_PACKAGE_BYTES) return null;
    const value = JSON.parse(await readFile(path, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return Object.freeze({
      name: text(value.name), type: text(value.type), main: text(value.main),
      bin: stringKeys(value.bin), scripts: stringKeys(value.scripts),
      package_manager: text(value.packageManager), engines: stringRecord(value.engines),
    });
  } catch { return null; }
}

async function regularFile(path) {
  try { const info = await lstat(path); return info.isFile() && !info.isSymbolicLink(); }
  catch { return false; }
}

function text(value) { return typeof value === 'string' && value.length <= 512 ? value : null; }
function stringKeys(value) {
  if (typeof value === 'string') return ['default'];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value).filter((key) => key.length <= 128).sort().slice(0, 64) : [];
}
function stringRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .filter(([key, item]) => key.length <= 128 && typeof item === 'string' && item.length <= 512)
    .sort(([left], [right]) => left.localeCompare(right)).slice(0, 32));
}
function summary(value) {
  return {
    repository: value.repository, manifests: value.manifests, guidance: value.guidance,
    source_directories: value.source_directories, test_directories: value.test_directories,
    entry_points: value.entry_points, truncated: value.truncated,
  };
}
