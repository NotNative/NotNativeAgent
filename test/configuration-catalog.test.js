// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { CONFIGURATION_CATALOG, buildConfigurationCatalog } from '../src/configuration-catalog.js';
import { CONFIGURATION_METADATA } from '../src/configuration-catalog-metadata.js';
import { CONFIGURATION_KEYS, MANIFEST_SHAPE_DESCRIPTORS } from '../src/configuration-keys.js';
import { CONFIGURATION_RULES } from '../src/configuration-rules.js';
import { resolveManifest } from '../src/config.js';

const field = (path) => CONFIGURATION_CATALOG.fields.find((entry) => entry.path === path);

test('catalog completely classifies actual structural keys and every scalar rule', () => {
  const paths = new Set(CONFIGURATION_CATALOG.fields.map(({ path }) => path));
  const rulePaths = new Set(CONFIGURATION_CATALOG.fields.map(({ validation }) => validation.rule).filter(Boolean));
  for (const descriptor of MANIFEST_SHAPE_DESCRIPTORS.filter(({ family }) => family)) {
    for (const key of descriptor.keys) {
      const template = descriptor.path === '$' ? key : `${descriptor.path}.${key}`;
      for (const path of template.includes('{role}') ? CONFIGURATION_KEYS.roles.map((role) => template.replace('{role}', role)) : [template]) assert.ok(paths.has(path), path);
    }
  }
  assert.deepEqual(rulePaths, new Set(Object.keys(CONFIGURATION_RULES)));
  assert.equal(paths.size, CONFIGURATION_CATALOG.fields.length);
  assert.deepEqual([...paths], [...paths].sort());
});

test('new unclassified keys and rules fail rather than acquire generic editability', () => {
  const shapeDescriptors = MANIFEST_SHAPE_DESCRIPTORS.map((shape) => shape.path === '$' ? { ...shape, keys: [...shape.keys, 'future_setting'] } : shape);
  assert.throws(() => buildConfigurationCatalog({ shapeDescriptors }), /unclassified keys in manifest/u);
  assert.throws(() => buildConfigurationCatalog({ shapeDescriptors: [...MANIFEST_SHAPE_DESCRIPTORS,
    { path: 'future_authority', family: null, kind: 'object', keys: ['enabled'] }] }), /unclassified (?:shape|structural path)/u);
  const additionalShape = [...MANIFEST_SHAPE_DESCRIPTORS, { ...MANIFEST_SHAPE_DESCRIPTORS[1], path: 'future_provider' }];
  assert.throws(() => buildConfigurationCatalog({ shapeDescriptors: additionalShape }), /unclassified structural path/u);
  const rules = { ...CONFIGURATION_RULES, future_setting: { path: 'future_setting', aliases: [] } };
  assert.throws(() => buildConfigurationCatalog({ rules }), /unclassified scalar rule/u);
  const metadata = structuredClone(CONFIGURATION_METADATA);
  delete metadata.provider.model.classification;
  assert.throws(() => buildConfigurationCatalog({ metadata }), /incomplete metadata provider.model/u);
});

test('catalog is deterministic, frozen and independent of environment and current directory', () => {
  const first = JSON.stringify(CONFIGURATION_CATALOG);
  assert.equal(JSON.stringify(buildConfigurationCatalog()), first);
  assert.throws(() => field('memory.enabled').default.value = false, TypeError);
  assert.throws(() => CONFIGURATION_METADATA.memory.enabled.default.value = false, TypeError);
  const moduleUrl = new URL('../src/configuration-catalog.js', import.meta.url).href;
  const source = `import {CONFIGURATION_CATALOG as catalog} from ${JSON.stringify(moduleUrl)}; process.stdout.write(JSON.stringify(catalog));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { cwd: tmpdir(), encoding: 'utf8', env: { ...process.env, NNA_CATALOG_SECRET: 'catalog-sentinel-secret' } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, first);
  assert.ok(!first.includes('catalog-sentinel-secret'));
});

test('numeric defaults distinguish parsing from effective inheritance and share authoritative bounds', () => {
  assert.equal(field('provider.context_limit_bytes').validation.rule, 'providers[*].context_limit_bytes');
  assert.equal(field('routes.primary.deadline_ms').validation.rule, 'provider_timeout_ms');
  assert.equal(field('routes.reviewer.deadline_ms').validation.rule, 'routes.{role}.deadline_ms');
  assert.equal(field('routes.primary.deadline_ms').unset.zero, 'disabled');
  assert.equal(field('routes.reviewer.deadline_ms').effective_zero, 'disabled');
  assert.deepEqual(field('routes.reviewer.deadline_ms').default, { kind: 'inherited', source: 'provider_timeout_ms' });
  assert.deepEqual(field('routes.reviewer.deadline_ms').parser_default, { kind: 'literal', value: null });
  assert.equal(field('routes.primary.temperature').effective_zero, 'unset');
  assert.equal(field('recovery.turn_wall_clock_ms').unset.zero, 'unset');
  assert.equal(CONFIGURATION_CATALOG.scalar_rules['routes.{role}.budget'].maximum, CONFIGURATION_RULES['routes.{role}.budget'].maximum);
  assert.equal(field('telemetry.retention').type, 'string');
  assert.equal(field('context_compression_level_2_threshold').default.kind, 'computed');
});

test('authority, forced streaming and secret references never become generic editable grants', () => {
  for (const entry of CONFIGURATION_CATALOG.fields) {
    assert.equal(entry.editability.available, false);
    if (['authority_grant', 'internal_invariant', 'generated_state'].includes(entry.classification)) assert.equal(entry.editability.generic_editable, false, entry.path);
    if (entry.sensitivity === 'credential_reference') assert.equal(entry.editability.generic_editable, false, entry.path);
  }
  assert.equal(field('providers[*].capabilities.streaming').classification, 'generated_state');
  assert.equal(field('providers[*].capabilities.streaming').default.value, true);
  assert.deepEqual(field('allowed_tools').source_layers, ['authenticated_host']);
  assert.equal(field('provider.model').alias_of, 'providers[*].model');
  assert.equal(field('provider.model').logical_path, field('providers[*].model').logical_path);
  assert.equal(field('provider.credential_env').logical_path, field('providers[*].credential_env').logical_path);
  assert.equal(field('providers[*].trust_zone').default.kind, 'absent');
});

test('application evidence retains immutable sessions, constructor state and unverified behavior', () => {
  for (const path of ['workspace_root', 'persistence', 'mcp_servers[*].credential.name', 'mcp_servers[*].endpoint', 'mission.bounds.max_turns']) assert.equal(field(path).application.class, 'new_session', path);
  assert.equal(field('dream.retention_days').application.class, 'construction_only');
  assert.equal(field('tui.key_bindings.cancel').application.class, 'surface_invocation');
  assert.equal(field('telemetry.retention').application.class, 'unverified');
  assert.equal(field('provider_timeout_ms').application.class, 'engine_boundary');
});

test('source precedence includes explicit configuration and MCP fields identify their active transport', () => {
  assert.deepEqual(CONFIGURATION_CATALOG.source_layers, ['compiled_default', 'user', 'project', 'explicit', 'launch_override', 'session']);
  assert.ok(field('memory.enabled').source_layers.includes('explicit'));
  for (const key of ['command', 'args', 'cwd']) assert.equal(field(`mcp_servers[*].${key}`).active_when, 'transport_stdio');
  assert.equal(field('mcp_servers[*].endpoint').active_when, 'transport_streamable_http');
  const provider = { endpoint: 'http://127.0.0.1:9/v1', model: 'base', trust_zone: 'loopback' };
  const http = resolveManifest({ provider, mcp_servers: [{ id: 'http', transport: 'streamable_http', endpoint: 'http://127.0.0.1:10/mcp', command: 123, args: false, cwd: 123 }] }).mcpServers[0];
  assert.equal(Object.hasOwn(http, 'command'), false);
  const stdio = resolveManifest({ provider, mcp_servers: [{ id: 'stdio', transport: 'stdio', command: 'example', endpoint: 123 }] }).mcpServers[0];
  assert.equal(Object.hasOwn(stdio, 'endpoint'), false);
});

test('catalog acceptance preserves permissive native fields instead of inventing strict types', () => {
  const provider = { endpoint: 'http://127.0.0.1:9/v1', model: 'base', trust_zone: 'loopback', capabilities: { streaming: false, tools: 'future' } };
  const config = resolveManifest({ provider, attachments: { enabled: 'legacy' }, routes: { primary: { model: 123 } }, telemetry: { enabled: true, destination: 'https://example.com', retention: 'operator-policy' } });
  assert.equal(config.providerProfiles['manifest-primary'].capabilities.streaming, true);
  assert.equal(config.providerProfiles['manifest-primary'].capabilities.tools, 'unknown');
  assert.equal(config.attachments.enabled, true);
  assert.equal(config.routes.primary.model, 123);
  assert.equal(field('routes.primary.model').type, 'unknown');
  assert.equal(field('attachments.enabled').acceptance, 'except_exact_false');
  assert.equal(field('mcp_servers[*].tool_effects.{tool}').acceptance, 'unvalidated_entry_preserved');
  assert.equal(field('mcp_servers[*].tool_effects.{tool}').editability.generic_editable, false);
});
