// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { runtimeEnvironment } from '../src/environment-settings.js';
import { terminalCapabilities } from '../src/tui/terminal-adapter.js';

test('AC-CONF-03 runtime environment booleans are typed and never silently coerced', () => {
  assert.deepEqual(runtimeEnvironment({}), { reducedMotion: false, noColor: false });
  assert.deepEqual(runtimeEnvironment({ NNA_REDUCED_MOTION: '1', NO_COLOR: '' }), {
    reducedMotion: true, noColor: true,
  });
  assert.equal(runtimeEnvironment({ NNA_REDUCED_MOTION: '0' }).reducedMotion, false);
  assert.throws(() => runtimeEnvironment({ NNA_REDUCED_MOTION: 'true' }), { code: 'environment_boolean_invalid' });
  const capabilities = terminalCapabilities(
    { isTTY: true }, { isTTY: true, columns: 80, rows: 24 },
    { environment: { NNA_REDUCED_MOTION: '1' } },
  );
  assert.equal(capabilities.reducedMotion, true);
  assert.equal(capabilities.keyboardProtocol, 'none');
  assert.equal(capabilities.alternateScreen, false);
  assert.equal(terminalCapabilities(
    { isTTY: true }, { isTTY: true, columns: 80, rows: 24 }, { alternateScreen: true },
  ).alternateScreen, true);
  assert.equal(terminalCapabilities(
    { isTTY: true }, { isTTY: true, columns: 80, rows: 24 },
    { environment: { WT_SESSION: 'windows-terminal-session' } },
  ).keyboardProtocol, 'kitty');
});
