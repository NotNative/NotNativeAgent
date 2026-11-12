// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { toolCatalogContext } from '../src/tools/catalog-context.js';

test('compact tool catalog lists unloaded installed names in deterministic order', () => {
  const content = toolCatalogContext([
    { name: 'mcp_memory_store' }, { name: 'fs_read_text' },
    { name: 'mcp_memory_search' }, { name: 'mcp_memory_store' },
  ], [{ type: 'function', function: { name: 'fs_read_text' } }]);
  assert.match(content, /\["fs_read_text","mcp_memory_search","mcp_memory_store"\]/u);
  assert.doesNotMatch(content, /\[.*fs\.read_text/u);
  assert.match(content, /needs no loading/u);
  assert.match(content, /"specialist":\["mcp_memory_search","mcp_memory_store"\]/u);
  assert.match(content, /no tier grants authority/u);
  assert.match(content, /every call still requires mandatory review/u);
});

test('compact tool catalog lists loaded names instead of omitting itself', () => {
  // Why the loaded names stay listed: the static catalog never subtracts the
  // loaded surface, so its text stays stable across a turn and the provider's
  // prompt prefix stays cacheable. A loaded name carries a "needs no loading"
  // marker rather than disappearing from the catalog.
  const content = toolCatalogContext(
    [{ name: 'fs_read_text' }],
    [{ type: 'function', function: { name: 'fs_read_text' } }],
  );
  assert.match(content, /\["fs_read_text"\]/u);
  assert.match(content, /needs no loading/u);
});

test('compact tool catalog remains bounded for a large dynamic registry', () => {
  const snapshot = Array.from({ length: 1_000 }, (_, index) => ({
    name: `mcp_large_tool_${String(index).padStart(4, '0')}_${'x'.repeat(40)}`,
  }));
  const content = toolCatalogContext(snapshot, []);
  assert.ok(Buffer.byteLength(content, 'utf8') < 34 * 1024);
  assert.match(content, /additional installed tool names were omitted/u);
});
