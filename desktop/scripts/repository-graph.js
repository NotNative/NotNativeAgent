// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const graphPath = join(root, 'docs', 'architecture', 'repository-graph.json');
const documentPath = join(root, 'docs', 'architecture', 'repository-graph.md');
const SOURCE_ROOTS = Object.freeze(['packages/ui/src', 'packages/web/src', 'scripts']);
const MAX_SOURCE_FILES = 2_000;
const SOURCE_EXTENSIONS = /\.(ts|tsx|mjs|js)$/u;
const EXCLUDED_PATH = /(^\\?|\/)(__tests__|node_modules|dist)(\/|$)|\.test\.[tj]sx?$|\.d\.ts$/u;

const COMPONENTS = Object.freeze([
  component('sync-engine', 'Client sync and state engine', 'Owns the event pipeline, stores, bootstrap, recovery, and materialization (doc 04).', matches('packages/ui/src/sync/')),
  component('harness-facade', 'Harness SDK facade', 'Owns the browser-to-harness contract client and wire types (docs 02/04).', matches('packages/ui/src/lib/nnd/')),
  component('runtime-io', 'Runtime adaptation', 'Owns fetch bridge, auth, url tokens, endpoint switching, boot pipeline (doc 01).', matches('packages/ui/src/lib/')),
  component('ui-shell', 'UI shell', 'Owns app regions, chat placeholders, stores first paint, boot state.', (path) => path.startsWith('packages/ui/src/') && !path.startsWith('packages/ui/src/sync/') && !path.startsWith('packages/ui/src/lib/')),
  component('web-server', 'Web server', 'Owns Hono routes, harness adapters, SSE control stream, static serving (docs 03/02).', matches('packages/web/src/server/')),
  component('web-entry', 'Web entrypoints', 'Owns Vite entry, base components, and browser adapter factory.', matches('packages/web/src/')),
  component('gates', 'Quality gates', 'Owns POWER10, NND-CTL, graph, release, and smoke tooling (ADR 0016/0017).', matches('scripts/')),
  component('foundation', 'Product foundation', 'Provides everything the components above have not claimed.', () => true),
]);

const OWNERSHIP_EDGES = Object.freeze([
  ['ui-shell', 'sync-engine', 'subscribes to engine state'],
  ['ui-shell', 'harness-facade', 'issues interim legacy calls (slated for removal in P2)'],
  ['sync-engine', 'harness-facade', 'issues harness requests'],
  ['sync-engine', 'runtime-io', 'rides runtime fetch, runtime key, and persistence'],
  ['web-entry', 'ui-shell', 'mounts the shell'],
  ['web-server', 'harness-facade', 'shares mirrored wire constants and event types'],
  ['gates', 'foundation', 'audits production sources'],
]);

const ENTRYPOINTS = new Set([
  'packages/web/src/server/index.ts',
  'packages/web/src/main.tsx',
  'packages/ui/src/main.tsx',
  'scripts/dev.mjs',
]);

export async function buildRepositoryGraph(repositoryRoot = root) {
  const files = await collectSourceFiles(repositoryRoot);
  const known = new Set(files.map((path) => portable(relative(repositoryRoot, path))));
  const sourceDigest = createHash('sha256');
  const modules = [];
  const externalDependencies = new Set();
  for (const path of files) {
    const modulePath = portable(relative(repositoryRoot, path));
    const source = await readFile(path, 'utf8');
    sourceDigest.update(modulePath).update(' ').update(source.replace(/\r\n?/gu, '\n')).update(' ');
    const imports = resolveImports(source, modulePath, known, externalDependencies);
    modules.push({ path: modulePath, component: classify(modulePath), entrypoint: ENTRYPOINTS.has(modulePath), imports });
  }
  const componentEdges = aggregateEdges(modules);
  const components = COMPONENTS.map(({ id, label, ownership }) => ({
    id, label, ownership, module_count: modules.filter((item) => item.component === id).length,
  }));
  return {
    schema_version: 1,
    generated_by: 'scripts/repository-graph.js',
    scope: 'packages/ui/src, packages/web/src, scripts',
    source_digest: `sha256:${sourceDigest.digest('hex')}`,
    counts: { modules: modules.length, component_edges: componentEdges.length },
    components,
    entrypoints: modules.filter((item) => item.entrypoint).map((item) => item.path),
    external_dependencies: [...externalDependencies].sort(),
    component_edges: componentEdges,
    modules,
  };
}

export function classify(path) {
  return COMPONENTS.find((item) => item.accepts(path)).id;
}

export function renderDocument(graph) {
  const byId = new Map(graph.components.map((item) => [item.id, item]));
  const incoming = new Map(graph.components.map((item) => [item.id, new Set()]));
  const outgoing = new Map(graph.components.map((item) => [item.id, new Set()]));
  for (const edge of graph.component_edges) {
    outgoing.get(edge.from)?.add(edge.to);
    incoming.get(edge.to)?.add(edge.from);
  }
  const rows = graph.components.map((item) => (
    `| ${item.label} | ${item.module_count} | ${names(outgoing.get(item.id), byId)} | ${names(incoming.get(item.id), byId)} |`
  ));
  const strongest = graph.component_edges.slice(0, 24).map((edge) => (
    `| ${byId.get(edge.from).label} | ${byId.get(edge.to).label} | ${edge.import_count} | ${edge.module_count} |`
  ));
  const topology = OWNERSHIP_EDGES.map(([from, to, label]) => `  ${mermaidId(from)} -->|${label}| ${mermaidId(to)}`);
  const nodes = graph.components.map((item) => `  ${mermaidId(item.id)}["${item.label}"]`);
  return `# Repository graph

This bounded map is generated from NotNativeDesktop production sources. It is a navigation aid:
code and the accepted architecture decisions remain authoritative. The complete module
adjacency list lives in [repository-graph.json](repository-graph.json).

Rebuild with \`npm run graph:build\`; \`npm run graph:check\` fails when source relationships
drift from the committed graph. Artifacts contain only repository-relative paths, declared
component ownership, static local imports, and bare Node module names.

## Ownership topology

The diagram states intended boundaries; the tables below are measured from imports.

\`\`\`mermaid
graph LR
${nodes.join('\n')}
${topology.join('\n')}
\`\`\`

## Component inventory

| Component | Modules | Imports from | Imported by |
|---|---:|---|---|
${rows.join('\n')}

## Strongest observed component dependencies

| Importer | Imported component | Imports | Importing modules |
|---|---|---:|---:|
${strongest.join('\n')}

## Process entry points

${graph.entrypoints.map((path) => `- \`${path}\``).join('\n')}

Source fingerprint: \`${graph.source_digest}\`.
`;
}

async function main() {
  const graph = await buildRepositoryGraph(root);
  const json = `${JSON.stringify(graph, null, 2)}\n`;
  const document = renderDocument(graph);
  if (process.argv.includes('--check')) {
    const mismatches = [];
    if (await committed(graphPath) !== json) mismatches.push(portable(relative(root, graphPath)));
    if (await committed(documentPath) !== document) mismatches.push(portable(relative(root, documentPath)));
    if (mismatches.length > 0) throw new Error(`repository graph is stale: ${mismatches.join(', ')}; run npm run graph:build`);
    process.stdout.write(`repository graph is current for ${graph.counts.modules} modules\n`);
    return;
  }
  await mkdir(dirname(graphPath), { recursive: true });
  await Promise.all([writeFile(graphPath, json, 'utf8'), writeFile(documentPath, document, 'utf8')]);
  process.stdout.write(`repository graph written for ${graph.counts.modules} modules\n`);
}

// ── collection + module resolution ───────────────────────────────────────────

async function collectSourceFiles(repositoryRoot) {
  const pending = SOURCE_ROOTS.map((value) => join(repositoryRoot, value));
  const result = [];
  while (pending.length > 0) {
    const current = pending.pop();
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); }
    catch (error) {
      throw new Error(`cannot inspect ${current}: ${error.code ?? error.message}`, { cause: error });
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      const modulePath = portable(relative(repositoryRoot, path));
      if (entry.isDirectory()) {
        if (!/__tests__|node_modules/u.test(entry.name)) pending.push(path);
        continue;
      }
      if (!SOURCE_EXTENSIONS.test(entry.name)) continue;
      if (EXCLUDED_PATH.test(modulePath)) continue;
      result.push(path);
      if (result.length > MAX_SOURCE_FILES) throw new Error(`source file count exceeds ${MAX_SOURCE_FILES}`);
    }
  }
  return result.sort((left, right) => portable(left).localeCompare(portable(right)));
}

function resolveImports(source, modulePath, known, externalDependencies) {
  const specifiers = new Set();
  for (const match of source.matchAll(IMPORT_DECLARATION)) specifiers.add(match[1]);
  for (const match of source.matchAll(DYNAMIC_IMPORT)) specifiers.add(match[1]);
  const imports = [];
  for (const specifier of [...specifiers].sort()) {
    if (specifier.startsWith('@notnative/')) {
      const mapped = mappedWorkspaceSpecifier(specifier);
      const resolved = mapped && resolveKnownImport(mapped, known);
      if (resolved) imports.push(resolved);
      continue;
    }
    if (!specifier.startsWith('.')) { externalDependencies.add(specifier); continue; }
    const candidate = posix.normalize(posix.join(posix.dirname(modulePath), specifier));
    const resolved = resolveKnownImport(candidate, known);
    if (resolved) imports.push(resolved);
  }
  return imports.sort();
}

function mappedWorkspaceSpecifier(specifier) {
  if (!specifier.startsWith('@notnative/ui/')) return null;
  return `packages/ui/src/${specifier.slice('@notnative/ui/'.length)}`;
}

function resolveKnownImport(candidate, known) {
  if (known.has(candidate)) return candidate;
  if (posix.extname(candidate)) return null;
  for (const extension of ['.ts', '.tsx', '.mjs', '.js']) {
    if (known.has(`${candidate}${extension}`)) return `${candidate}${extension}`;
  }
  for (const extension of ['.ts', '.tsx', '.mjs', '.js']) {
    const index = posix.join(candidate, `index${extension}`);
    if (known.has(index)) return index;
  }
  return null;
}

const IMPORT_DECLARATION = /(?:^|\n)\s*(?:import\s+(?:type\s+)?(?:[^'";]+?\s+from\s+)?|export\s+(?:type\s+)?[^'";]+?\s+from\s+)['"]([^'"]+)['"]/gu;
const DYNAMIC_IMPORT = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/gu;

function aggregateEdges(modules) {
  const componentByPath = new Map(modules.map((item) => [item.path, item.component]));
  const edges = new Map();
  for (const module of modules) {
    for (const imported of module.imports) {
      const target = componentByPath.get(imported);
      if (!target || target === module.component) continue;
      const key = `${module.component} ${target}`;
      const edge = edges.get(key) ?? { from: module.component, to: target, import_count: 0, modules: new Set() };
      edge.import_count += 1;
      edge.modules.add(module.path);
      edges.set(key, edge);
    }
  }
  return [...edges.values()].map((edge) => ({
    from: edge.from, to: edge.to, import_count: edge.import_count, module_count: edge.modules.size,
  })).sort((left, right) => (
    right.import_count - left.import_count || left.from.localeCompare(right.from) || left.to.localeCompare(right.to)
  ));
}

function component(id, label, ownership, accepts) { return Object.freeze({ id, label, ownership, accepts }); }
function matches(...values) { return (path) => values.some((value) => path === value || path.startsWith(value)); }
function portable(path) { return path.split(sep).join('/'); }
function mermaidId(value) { return value.replaceAll('-', '_'); }
function names(values, byId) {
  const labels = [...(values ?? [])].map((id) => byId.get(id)?.label ?? id).sort();
  return labels.length > 0 ? labels.join(', ') : '—';
}
async function committed(path) {
  return readFile(path, 'utf8').catch((error) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
