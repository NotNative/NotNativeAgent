// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { INVOCATION_VOCABULARY, parseCli } from '../src/cli-options.js';
import { createNndInvocationService, projectInvocation,
  dispatchNndInvocationRequest } from '../src/nnd-invocation-routes.js';
import { startIntegrationServer } from '../src/integration-server.js';
import { createNndLocalIntegrationActivation } from '../src/nno-integration-activation.js';

const token = 'invocation-vocab-token-32-characters-long-testok';
const PERMITTED = { subjectId: 'operator@example.com',
  permissions: ['nnd.configuration.read', 'nnd.service.manage'] };

/** The census id for a flag (the -21 slice pins one operator_action row per
 * vocabulary entry; aliases are sibling rows captured on the pinned entry). */
function operatorActionFlag(censusFlag) {
  const entry = INVOCATION_VOCABULARY.flags.find((item) => item.flag === censusFlag
    || item.aliases.includes(censusFlag));
  return entry ? entry.flag : null;
}

test('the vocabulary is mechanically consistent with parseCli', () => {
  assert.equal(INVOCATION_VOCABULARY.flags.length, 23);
  const seen = new Set();
  for (const entry of INVOCATION_VOCABULARY.flags) {
    // Every row is its own identity (aliases are sibling rows with their
    // own entries); each resolves through parseCli in each allowed mode.
    const flag = entry.flag;
    seen.add(flag);
    const modes = entry.modes === '*' ? ['tui', 'text'] : entry.modes;
    for (const mode of modes) {
      const argv = entry.modes === '*' ? [flag] : [mode, flag];
      if (entry.argument === 'value') argv.push(entry.flag === '--port' ? '8902'
        : entry.flag === '--provider-credential-env' ? 'SAMPLE_ENV_NAME' : 'sample-value');
      if (entry.argument === 'prompt-text') argv.push('hello world');
      const parsed = parseCli(argv);
      if (entry.option === null) {
        assert.equal(parsed.mode, entry.flag, `${entry.flag} selects its informational mode`);
      } else if (entry.option === 'prompt') {
        if (entry.argument === 'prompt-text') assert.deepEqual([...parsed.prompt], ['hello world']);
        else assert.ok(parsed.prompt.includes(flag), `${flag} lands in the subcommand prompt`);
      } else {
        const sample = entry.flag === '--port' ? 8902
          : entry.flag === '--provider-credential-env' ? 'SAMPLE_ENV_NAME' : 'sample-value';
        assert.equal(parsed[entry.option], entry.argument === 'value' ? sample
          : entry.flag === '--no-color' ? false : true, `${flag} lands on ${entry.option}`);
      }
    }
    // The headless restriction the rows declare matches the parser's guard.
    if (entry.headless === false && entry.modes === '*') {
      const guardSample = entry.flag === '--provider-credential-env' ? 'SAMPLE_ENV_NAME' : 'sample-value';
      assert.throws(() => parseCli(['host', entry.flag, ...(entry.argument === 'none' ? [] : [guardSample])]),
        { code: 'host_override_requires_manifest' });
    }
  }
  // Mode-restricted branches really are mode-restricted.
  assert.throws(() => parseCli(['--hostname', 'h']), { code: 'invalid_option' });
  assert.equal(parseCli(['opencode', '--hostname', 'h']).serveHostname, 'h');
  assert.throws(() => parseCli(['--port', '70000']), { code: 'invalid_option' });
  assert.equal(parseCli(['opencode', '--port', '8902']).servePort, 8902);
  assert.throws(() => parseCli(['--unknown-flag']), { code: 'invalid_option' });
  // The row set is exactly the census vocabulary.
  assert.deepEqual([...seen].sort(), ['--check', '--config', '--delete-user-data', '--help', '--hostname',
    '--json', '--keep-user-data', '--manifest', '--model', '--no-color', '--port',
    '--prompt', '--provider', '--provider-credential-env', '--provider-endpoint',
    '--provider-profile', '--reduced-motion', '--session', '--version', '-h', '-p',
    '-provider', '-v']);
});

test('the invocation service projects the vocabulary and fails closed on drift', async () => {
  const service = createNndInvocationService({ installationId: 'install_inv', dataId: 'data_inv' });
  const receipt = projectInvocation(await service.read());
  assert.equal(receipt.family, 'invocation');
  assert.equal(receipt.flags.length, 23);
  assert.ok(receipt.modes.includes('tui'));
  const credential = receipt.flags.find((flag) => flag.flag === '--provider-credential-env');
  assert.equal(credential.headless, false);
  const endpointIndex = receipt.flags.findIndex((flag) => flag.flag === '--provider-endpoint');
  const flipped = receipt.flags.map((flag, index) =>
    index === endpointIndex ? { ...flag, headless: true } : { ...flag });
  for (const drift of [{ ...receipt, family: 'gateway' },
    { ...receipt, flags: receipt.flags.slice(1) },
    { ...receipt, flags: flipped },
    { ...receipt, modes: [] },
    { ...receipt, extra: true },
    null]) {
    assert.throws(() => projectInvocation(drift),
      (error) => error.code === 'nnd_invocation_projection_invalid');
  }
  assert.throws(() => createNndInvocationService({ installationId: '', dataId: 'data_inv' }),
    { code: 'nnd_invocation_request_invalid' });
  const vocGuard = INVOCATION_VOCABULARY.flags.map((entry) =>
    entry.modes === '*' ? entry : [entry, entry]);
  assert.ok(vocGuard.length >= 23, 'vocabulary enumeration stays aligned');
});

test('action triage HTTP matrix for the invocation vocabulary', async t => {
  const t0 = Date.now();
  void t0;
  const service = createNndInvocationService({ installationId: 'install_inv', dataId: 'data_inv' });
  const instance = await startIntegrationServer({ activation: createNndLocalIntegrationActivation(), token,
    host: '127.0.0.1', port: 0,
    nndRuntime: { getHost: () => ({ workspaceRoot: 'C:\\workspace' }),
      snapshot: () => ({ service_state: 'setup_required', execution_state: 'unavailable' }) },
    resolvePrincipal: () => PERMITTED, nndInvocationService: service });
  t.after(() => instance.close());
  const endpoint = `http://127.0.0.1:${instance.address.port}`;
  const call = async (suffix, { method = 'GET', bearer = token } = {}) => {
    const response = await fetch(`${endpoint}/v1/nnd/configuration/${suffix}`, { method,
      headers: { authorization: bearer ? `Bearer ${bearer}` : '' } });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  assert.equal((await call('invocation', { bearer: null })).status, 401);
  assert.equal((await call('invocation', { method: 'POST' })).status, 405);
  assert.equal((await call('invocation?x=1')).status, 400);
  const read = await call('invocation');
  assert.equal(read.status, 200);
  assert.equal(read.body.flags.length, 23);
  const drifted = createNndInvocationService({ installationId: 'install_inv', dataId: 'data_inv' });
  assert.ok(drifted.read, 'service stays constructible for a second read');
  assert.equal((await call('invocation-other')).status, 404);
  assert.equal(await dispatchNndInvocationRequest({}, {}, { url: new URL('http://x/other'),
    principal: PERMITTED }), false, 'unrelated paths return false for the router chain');
});
