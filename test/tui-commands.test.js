// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { TUI_COMMANDS } from '../src/tui/commands.js';

// Frozen-shape invariant for the terminal command palette (census
// tui_commands:vocabulary): pins the entry shape and internal consistency of
// TUI_COMMANDS, not specific command names, so legitimately adding a command
// does not break this test.
test('TUI_COMMANDS is a non-empty frozen array whose entries carry the documented shape', () => {
  assert.ok(Array.isArray(TUI_COMMANDS) && TUI_COMMANDS.length > 0);
  assert.equal(Object.isFrozen(TUI_COMMANDS), true);
  const usages = new Set();
  for (const item of TUI_COMMANDS) {
    assert.equal(Object.isFrozen(item), true);
    assert.equal(typeof item.name, 'string');
    assert.match(item.name, /^\/[a-z0-9-]+/u);
    assert.equal(typeof item.usage, 'string');
    assert.ok(item.usage.startsWith(item.name));
    assert.equal(typeof item.description, 'string');
    assert.ok(item.description.length > 0);
    assert.equal(typeof item.category, 'string');
    assert.ok(item.category.length > 0);
    // Availability: every entry declares runtime availability, a capability
    // requirement, and a binding action that is null or a known key binding.
    assert.equal(item.availability, 'runtime');
    assert.equal(typeof item.requiredCapability, 'string');
    assert.ok(item.requiredCapability.length > 0);
    assert.ok(item.bindingAction === null || typeof item.bindingAction === 'string');
    assert.equal(item.origin, 'core');
    // Why (uniformity audit): TUI_COMMANDS deliberately lists USAGE VARIANTS
    // under one name (nine /mcp forms, four /gateway forms, ...) — the palette
    // dedupes at resolution (deduplicateCommands in commands.js). The frozen
    // invariant is therefore unique (name, usage) PAIRS, not unique names.
    const pair = `${item.name}\u0000${item.usage}`;
    assert.equal(usages.has(pair), false, `duplicate command usage ${pair}`);
    usages.add(pair);
  }
});

test('TUI_COMMANDS capability requirements and binding actions stay internally consistent', () => {
  const knownCapabilities = new Set([
    'Console', 'configured memory adapter', 'configured MCP capability', 'local secret broker',
    'provider configuration', 'Telegram gateway configuration', 'attachment admission',
    'terminal clipboard capability', 'local diagnostic storage', 'local forensic telemetry',
  ]);
  for (const item of TUI_COMMANDS) {
    assert.ok(knownCapabilities.has(item.requiredCapability),
      `unknown capability ${item.requiredCapability}`);
    if (item.bindingAction !== null) {
      assert.ok(['/help', '/new', '/close', '/quit'].includes(item.name),
        `unexpected binding action on ${item.name}`);
    }
  }
});
