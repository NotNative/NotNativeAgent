// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { toolCatalogContext } from '../src/tool-catalog-context.js';

test('compact tool catalog lists only unloaded authorized names in deterministic order', () => {
  const content = toolCatalogContext([
    { name: 'mcp.memory.store' }, { name: 'fs.read_text' },
    { name: 'mcp.memory.search' }, { name: 'mcp.memory.store' },
  ], [{ type: 'function', function: { name: 'fs.read_text' } }]);
  assert.match(content, /\["mcp\.memory\.search","mcp\.memory\.store"\]/u);
  assert.doesNotMatch(content, /\[.*fs\.read_text/u);
  assert.match(content, /schemas are not loaded/u);
});

test('compact tool catalog is absent when every authorized schema is loaded', () => {
  const content = toolCatalogContext(
    [{ name: 'fs.read_text' }],
    [{ type: 'function', function: { name: 'fs.read_text' } }],
  );
  assert.equal(content, null);
});

test('compact tool catalog remains bounded for a large dynamic registry', () => {
  const snapshot = Array.from({ length: 1_000 }, (_, index) => ({
    name: `mcp.large.tool_${String(index).padStart(4, '0')}_${'x'.repeat(80)}`,
  }));
  const content = toolCatalogContext(snapshot, []);
  assert.ok(Buffer.byteLength(content, 'utf8') < 34 * 1024);
  assert.match(content, /additional authorized tool names were omitted/u);
});
