// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CONFIGURATION_RULES, resolveConfigurationScalar as scalar } from '../src/configuration-rules.js';
import { resolveManifest } from '../src/config.js';
import { providerTimeouts, providerRouteDeadlineOverride, semanticReviewTimeout } from '../src/config-bounds.js';
import { resolveContextLimits } from '../src/config-context.js';
import { validateDream } from '../src/dream-config.js';

const provider = { id: 'local', endpoint: 'http://127.0.0.1:9/v1', model: 'model', trust_zone: 'loopback' };

test('scalar descriptors are immutable static data with explicit unresolved default sources', () => {
  assert.equal(Object.keys(CONFIGURATION_RULES).length, 44);
  for (const [key, rule] of Object.entries(CONFIGURATION_RULES)) {
    assert.equal(rule.path, key);
    assert.ok(Object.isFrozen(rule) && Object.isFrozen(rule.default) && Object.isFrozen(rule.unset));
    assert.ok(Object.isFrozen(rule.aliases) && Object.isFrozen(rule.dependencies));
    assert.ok(['integer', 'number'].includes(rule.type));
    assert.throws(() => { rule.minimum = -1; }, TypeError);
    if (rule.default.kind !== 'literal') {
      assert.equal(Object.hasOwn(rule.default, 'value'), false);
      assert.throws(() => scalar(key, undefined), { code: 'configuration_rule_default_required' });
    }
  }
  assert.equal(CONFIGURATION_RULES['mission.bounds.max_turns'].classification, 'authority_grant');
  assert.doesNotMatch(JSON.stringify(CONFIGURATION_RULES), /[A-Z]:\\|127\.0\.0\.1|process\.env/u);
});

test('native limits preserve numeric type, inclusive bounds and exact failure category', () => {
  for (const [key, rule] of Object.entries(CONFIGURATION_RULES)) {
    assert.equal(scalar(key, rule.minimum), rule.minimum);
    assert.equal(scalar(key, rule.maximum), rule.maximum);
    for (const value of [rule.maximum + 1, NaN, Infinity, '10', false]) {
      assert.throws(() => scalar(key, value), { code: 'invalid_limit' });
    }
    if (rule.type === 'integer') assert.throws(() => scalar(key, rule.minimum + 0.5), { code: 'invalid_limit' });
  }
  assert.throws(() => resolveManifest({ provider, provider_concurrency: 17 }), { code: 'invalid_limit', message: 'limit must be an integer from 1 to 16' });
  assert.equal(resolveManifest({ provider, provider_concurrency: 16 }).limits.providerConcurrency, 16);
});

test('zero, null and omitted values retain distinct native meanings', () => {
  assert.equal(scalar('provider_timeout_ms', undefined), 1_800_000);
  assert.equal(scalar('provider_timeout_ms', 0), null);
  assert.throws(() => scalar('provider_timeout_ms', null), { code: 'invalid_limit' });
  for (const value of [undefined, null, 0]) assert.equal(scalar('recovery.turn_wall_clock_ms', value), null);
  assert.equal(scalar('providers[*].context_limit_bytes', undefined), null);
  for (const value of [null, 0]) assert.throws(() => scalar('providers[*].context_limit_bytes', value), { code: 'invalid_limit' });
  assert.equal(providerRouteDeadlineOverride(undefined), null);
  assert.equal(providerRouteDeadlineOverride(-0), 0);
  assert.ok(Object.is(scalar('routes.{role}.temperature', -0), -0));
  const config = resolveManifest({ provider, routes: { primary: { temperature: 0, max_output_tokens: 0, budget: null } } });
  assert.equal(config.routes.primary.temperatureOverride, 0);
  assert.equal(config.routes.primary.temperature, null);
  assert.equal(config.routes.primary.maxOutputTokens, null);
});

test('timeout inheritance and legacy migration remain native operations', () => {
  const inherited = providerTimeouts({ provider_timeout_ms: 1200, routes: { primary: { deadline_ms: 2500 } }, first_token_timeout_ms: 0 });
  assert.equal(inherited.providerMs, 2500);
  assert.equal(inherited.providerOverrideMs, 2500);
  assert.equal(inherited.firstTokenMs, null);
  assert.equal(inherited.firstTokenOverrideMs, 0);
  const migrated = providerTimeouts({ first_token_timeout_ms: 30000, idle_timeout_ms: 45000 });
  assert.equal(migrated.firstTokenMs, 600000); assert.equal(migrated.firstTokenOverrideMs, null);
  assert.equal(migrated.idleMs, 300000); assert.equal(migrated.idleOverrideMs, null);
  const formerPair = providerTimeouts({ first_token_timeout_ms: 600000, idle_timeout_ms: 300000 });
  assert.equal(formerPair.firstTokenOverrideMs, null); assert.equal(formerPair.idleOverrideMs, null);
  assert.equal(semanticReviewTimeout({ semantic_review_timeout_ms: 15000 }, 2500), 2500);
  assert.equal(semanticReviewTimeout({}, null), 1800000);
});

test('computed context defaults retain ordering validation and Dream keeps hosted disablement', () => {
  const limits = resolveContextLimits({ context_compression_threshold: 0.3, context_compaction_threshold: 0.9 });
  assert.equal(limits.contextCompressionLevel2Threshold, 0.3 + ((0.9 - 0.3) * 3 / 7));
  assert.equal(limits.contextCompressionLevel3Threshold, 0.3 + ((0.9 - 0.3) * 6 / 7));
  assert.throws(() => resolveContextLimits({ context_compression_level_2_threshold: 0.9 }), { code: 'context_thresholds_invalid' });
  assert.deepEqual(validateDream(undefined, null), { enabled: true, idleMs: 45000, interStageMs: 5000,
    inferenceIdleMs: 120000, hygieneIdleMs: 300000, retentionDays: 30 });
  assert.equal(validateDream({ enabled: true }, {}).enabled, false);
  assert.throws(() => validateDream({ retention_days: 366 }, null), { code: 'invalid_limit' });
});

test('provider, route and MCP settings consume their authoritative scalar bounds', () => {
  assert.throws(() => resolveManifest({ provider: { ...provider, output_limit_tokens: 1048577 } }), { code: 'invalid_limit' });
  assert.throws(() => resolveManifest({ provider, routes: { reviewer: { budget: 65 } } }), { code: 'invalid_limit' });
  const server = { id: 'example', transport: 'stdio', command: 'example', timeout_ms: 4500 };
  const config = resolveManifest({ provider, mcp_servers: [server] });
  assert.equal(config.mcpServers[0].connectTimeoutMs, 4500);
  assert.equal(config.mcpServers[0].listTimeoutMs, 4500);
  assert.equal(config.mcpServers[0].callTimeoutMs, 4500);
  assert.equal(config.mcpServers[0].shutdownTimeoutMs, 2000);
  assert.throws(() => resolveManifest({ provider, mcp_servers: [{ ...server, timeout_ms: null }] }), { code: 'invalid_limit' });
  assert.throws(() => resolveManifest({ provider, mcp_servers: [{ ...server, timeout_ms: null, credential: { source: 'invalid' } }] }), { code: 'credential_binding_invalid' });
  assert.throws(() => resolveManifest({ provider, mcp_servers: [{ ...server, shutdown_timeout_ms: 30001 }] }), { code: 'invalid_limit' });
});

test('manifest numeric validators cannot silently introduce parallel literal bounds', async () => {
  for (const file of ['config.js', 'config-context.js', 'dream-config.js']) {
    const source = await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\b(?:boundedInteger|boundedNumber|optionalBoundedInteger|optionalZeroUnsetInteger)\s*\(/u, file);
    for (const match of source.matchAll(/scalar\(\s*'([^']+)'/gu)) assert.ok(CONFIGURATION_RULES[match[1]], match[1]);
  }
});
