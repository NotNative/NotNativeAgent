// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const graphPath = join(root, 'docs', 'architecture', 'repository-graph.json');
const documentPath = join(root, 'docs', 'architecture', 'repository-graph.md');
const MAX_SOURCE_FILES = 2_000;

const COMPONENTS = Object.freeze([
  component('agentic-engine', 'Agentic Engine', 'Owns turns, steps, lifecycle, and orchestration.', matches('engine.js', 'engine/')),
  component('governance-engine', 'Governance Engine', 'Owns authority, review, permission, and execution policy.', matches(
    'governance-engine.js', 'governance/', 'authority.js', 'execution-policy.js', 'permission-broker.js',
    'preauthorization.js', 'review-evidence.js', 'review-posture.js', 'reviewer.js',
  )),
  component('experience-engine', 'Experience Engine', 'Owns operator interaction and presentation.', matches(
    'experience-engine.js', 'experience/', 'tui.js', 'tui/', 'plain-text.js',
  )),
  component('reliability-engine', 'Reliability Engine', 'Owns progress, context fitness, protocol integrity, and bounded recovery.', matches(
    'reliability-engine.js', 'reliability/', 'active-context-pressure.js', 'cold-context.js', 'compaction.js',
    'completion-supervisor.js', 'context-budget.js', 'context.js', 'continuation-artifact.js',
    'continuation-compactor.js', 'long-horizon-context.js', 'recovery.js',
  )),
  component('gateway', 'Gateway', 'Adapts authenticated remote operator traffic.', matches('gateway-cli.js', 'gateway/')),
  component('persistence', 'Persistence', 'Owns durable journals, locks, state, and atomic storage.', matches(
    'persistence/', 'store.js', 'structured-log.js',
  )),
  component('providers', 'Providers', 'Owns model routing and provider wire adaptation.', matches('provider.js', 'provider/')),
  component('tools', 'Tools', 'Owns built-in tool contracts and execution adapters.', (path) => (
    path.startsWith('tools/') || path === 'tool-registry.js' || path.endsWith('-tool.js')
    || path.endsWith('-tools.js')
  )),
  component('guidance', 'Guidance and extensions', 'Owns guidance, hooks, skills, and extension discovery.', (path) => (
    path.startsWith('guidance/') || path.startsWith('hook-') || path.startsWith('skill-') || path === 'extensions.js'
  )),
  component('integrations', 'Integration surfaces', 'Owns headless, NNO, sub-agent, and service boundaries.', (path) => (
    path === 'headless.js' || path.startsWith('integration-') || path.startsWith('nno-')
    || path.startsWith('secret-broker-') || path.startsWith('session-broker') || path.startsWith('subagent-')
  )),
  component('foundation', 'Product foundation', 'Provides shared configuration, contracts, telemetry, and product utilities.', () => true),
]);

const OWNERSHIP_EDGES = Object.freeze([
  ['experience-engine', 'agentic-engine', 'submits operator work'],
  ['gateway', 'agentic-engine', 'submits remote work'],
  ['integrations', 'agentic-engine', 'submits hosted work'],
  ['agentic-engine', 'governance-engine', 'requests authority decisions'],
  ['agentic-engine', 'reliability-engine', 'requests reliability decisions'],
  ['agentic-engine', 'providers', 'dispatches model requests'],
  ['agentic-engine', 'persistence', 'records durable evidence'],
  ['agentic-engine', 'tools', 'coordinates tool execution'],
  ['tools', 'governance-engine', 'executes reviewed actions'],
  ['providers', 'reliability-engine', 'reports route observations'],
]);

const ENTRYPOINTS = new Set([
  'src/cli.js', 'src/index.js', 'src/elevation-helper.js', 'src/forensic-telemetry-worker.js',
  'src/update-check-worker.js',
]);

export async function buildRepositoryGraph(repositoryRoot = root) {
  const sourceRoot = join(repositoryRoot, 'src');
  const files = await collectJavaScript(sourceRoot);
  const known = new Set(files.map((path) => portable(relative(repositoryRoot, path))));
  const sourceDigest = createHash('sha256');
  const modules = [];
  const externalDependencies = new Set();
  for (const path of files) {
    const modulePath = portable(relative(repositoryRoot, path));
    const source = await readFile(path, 'utf8');
    sourceDigest.update(modulePath).update('\0').update(source.replaceAll('\r\n', '\n')).update('\0');
    const imports = resolveImports(source, modulePath, known, externalDependencies);
    modules.push({
      path: modulePath, component: classify(modulePath.slice(4)), entrypoint: ENTRYPOINTS.has(modulePath), imports,
    });
  }
  const componentEdges = aggregateEdges(modules);
  const components = COMPONENTS.map(({ id, label, ownership }) => ({
    id, label, ownership, module_count: modules.filter((item) => item.component === id).length,
  }));
  return {
    schema_version: 1,
    generated_by: 'scripts/repository-graph.js',
    scope: 'src/**/*.js',
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
    outgoing.get(edge.from)?.add(edge.to); incoming.get(edge.to)?.add(edge.from);
  }
  const rows = graph.components.map((item) => (
    `| ${item.label} | ${item.module_count} | ${names(outgoing.get(item.id), byId)} | ${names(incoming.get(item.id), byId)} |`
  ));
  const strongest = graph.component_edges.slice(0, 24).map((edge) => (
    `| ${byId.get(edge.from).label} | ${byId.get(edge.to).label} | ${edge.import_count} | ${edge.module_count} |`
  ));
  const topology = OWNERSHIP_EDGES.map(([from, to, label]) => `  ${mermaidId(from)} -->|${label}| ${mermaidId(to)}`);
  const nodeDeclarations = graph.components.map((item) => `  ${mermaidId(item.id)}["${item.label}"]`);
  return `# Repository graph\n\n`+
    `This bounded map is generated from NNA's production JavaScript. It is a navigation aid, not `+
    `an authority source: code and accepted architecture decisions remain authoritative. The complete `+
    `module adjacency list lives in [repository-graph.json](repository-graph.json).\n\n`+
    `Rebuild with \`npm run graph:build\`. Use \`npm run graph:check\` for a focused check; the normal `+
    `\`npm run check\` gate also fails when source relationships drift from the committed graph. `+
    `Generated artifacts contain only repository-relative `+
    `paths, declared component ownership, static local imports, and Node.js module names.\n\n`+
    `## Ownership topology\n\n`+
    `This diagram captures the intended engine boundaries. The tables below are measured from imports.\n\n`+
    `\`\`\`mermaid\ngraph LR\n${nodeDeclarations.join('\n')}\n${topology.join('\n')}\n\`\`\`\n\n`+
    `## Component inventory\n\n`+
    `| Component | Modules | Imports from | Imported by |\n|---|---:|---|---|\n${rows.join('\n')}\n\n`+
    `## Strongest observed component dependencies\n\n`+
    `Counts represent static local imports. Same-component imports are included because they reveal `+
    `the internal cohesion of each subsystem.\n\n`+
    `| Importer | Imported component | Imports | Importing modules |\n|---|---|---:|---:|\n${strongest.join('\n')}\n\n`+
    `## Process entry points\n\n${graph.entrypoints.map((path) => `- \`${path}\``).join('\n')}\n\n`+
    `Source fingerprint: \`${graph.source_digest}\`.\n`;
}

async function main() {
  const graph = await buildRepositoryGraph(root);
  const json = `${JSON.stringify(graph, null, 2)}\n`;
  const document = renderDocument(graph);
  if (process.argv.includes('--check')) {
    const mismatches = [];
    if (await existing(graphPath) !== json) mismatches.push(portable(relative(root, graphPath)));
    if (await existing(documentPath) !== document) mismatches.push(portable(relative(root, documentPath)));
    if (mismatches.length > 0) throw new Error(`repository graph is stale: ${mismatches.join(', ')}; run npm run graph:build`);
    process.stdout.write(`repository graph is current for ${graph.counts.modules} modules\n`);
    return;
  }
  await mkdir(dirname(graphPath), { recursive: true });
  await Promise.all([writeFile(graphPath, json, 'utf8'), writeFile(documentPath, document, 'utf8')]);
  process.stdout.write(`repository graph written for ${graph.counts.modules} modules\n`);
}

async function collectJavaScript(directory) {
  const pending = [directory];
  const result = [];
  while (pending.length > 0) {
    const current = pending.pop();
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.endsWith('.js')) result.push(path);
      if (result.length > MAX_SOURCE_FILES) throw new Error(`source file count exceeds ${MAX_SOURCE_FILES}`);
    }
  }
  return result.sort((left, right) => portable(left).localeCompare(portable(right)));
}

function resolveImports(source, modulePath, known, externalDependencies) {
  const specifiers = new Set();
  const declaration = /(?:^|\n)\s*(?:import\s+(?:[^'";]+?\s+from\s+)?|export\s+[^'";]+?\s+from\s+)['"]([^'"]+)['"]/gu;
  const dynamic = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/gu;
  for (const expression of [declaration, dynamic]) {
    for (const match of source.matchAll(expression)) specifiers.add(match[1]);
  }
  const imports = [];
  for (const specifier of [...specifiers].sort()) {
    if (!specifier.startsWith('.')) { externalDependencies.add(specifier); continue; }
    const candidate = posix.normalize(posix.join(posix.dirname(modulePath), specifier));
    const normalized = candidate.endsWith('.js') ? candidate : `${candidate}.js`;
    if (known.has(normalized)) imports.push(normalized);
  }
  return imports.sort();
}

function aggregateEdges(modules) {
  const componentByPath = new Map(modules.map((item) => [item.path, item.component]));
  const edges = new Map();
  for (const module of modules) {
    const targets = new Map();
    for (const imported of module.imports) {
      const target = componentByPath.get(imported);
      if (!target) continue;
      const key = `${module.component}\0${target}`;
      const edge = edges.get(key) ?? { from: module.component, to: target, import_count: 0, modules: new Set() };
      edge.import_count += 1; edge.modules.add(module.path); edges.set(key, edge);
      targets.set(target, true);
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
async function existing(path) { return readFile(path, 'utf8').catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error)); }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
