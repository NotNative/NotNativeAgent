// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { validateCommand } from '../src/contracts.js';
import { PreauthorizationRegistry } from '../src/preauthorization.js';

const context = Object.freeze({ definition: Object.freeze({ sideEffect: 'reversible' }) });

test('AC-AUTH-05 conversation preauthorization is scoped, drift-sensitive, inspectable, and revocable', () => {
  const registry = new PreauthorizationRegistry();
  const first = request('one', 'a.txt');
  const exact = registry.grant('allow_session', first, context, 'operator');
  assert.equal(registry.match(request('two', 'a.txt'), context)?.id, exact.id);
  assert.equal(registry.match({ ...request('later-turn', 'a.txt'), authorityVersion: 2 }, context)?.id, exact.id);
  assert.equal(registry.match(request('three', 'b.txt'), context), null);
  assert.equal(registry.match({ ...request('four', 'a.txt'), policyVersion: 2 }, context), null);
  assert.equal(registry.match({ ...request('restricted', 'a.txt'), authorityRestrictionVersion: 1 }, context), null);
  assert.deepEqual(Object.keys(registry.snapshot()[0]).sort(), [
    'effect', 'expires_at', 'id', 'operation_family_fingerprint', 'principal', 'restriction_version', 'scope', 'target_fingerprint', 'tool',
  ]);
  assert.equal(registry.snapshot()[0].principal, 'operator');
  assert.throws(() => registry.revoke(exact.id, 'other-operator'), { code: 'preauthorization_forbidden' });
  assert.equal(registry.match(request('still-active', 'a.txt'), context)?.id, exact.id);
  assert.equal(registry.decision(exact, request('approved', 'a.txt')).authorityRestrictionVersion, 0);
  assert.equal(registry.revoke(exact.id, 'operator').revoked, true);
  assert.throws(() => registry.decision(exact, request('revoked', 'a.txt')), { code: 'preauthorization_decision_invalid' });
  assert.equal(registry.match(request('five', 'a.txt'), context), null);

  const workspace = registry.grant('allow_workspace', request('six', 'a.txt'), context, 'operator');
  assert.equal(registry.match(request('seven', 'b.txt'), context)?.id, workspace.id);
  assert.equal(registry.match({ ...request('eight', 'b.txt'), workspaceRoot: 'D:/other' }, context), null);
});

test('workspace execution grants bind to an operation family rather than every command', () => {
  const registry = new PreauthorizationRegistry();
  const review = { definition: { sideEffect: 'unknown' } };
  const status = compoundRequest('status-one', 'process.run', {
    path: 'D:/work', executable: 'git', argv: ['status'], reviewComplexity: 'simple_argv',
  });
  const grant = registry.grant('allow_workspace', status, review, 'operator');
  assert.equal(registry.match(compoundRequest('status-two', 'process.run', {
    path: 'D:/work/subdir', executable: 'git', argv: ['status'], reviewComplexity: 'simple_argv',
  }), review)?.id, grant.id);
  assert.equal(registry.match(compoundRequest('push', 'process.run', {
    path: 'D:/work', executable: 'git', argv: ['push'], reviewComplexity: 'simple_argv',
  }), review), null);

  const shell = compoundRequest('shell-one', 'shell.run', {
    path: 'D:/work', shell: 'powershell', script: 'Get-ChildItem | Select-Object Name', reviewComplexity: 'compound_shell',
  });
  registry.grant('allow_workspace', shell, review, 'operator');
  assert.ok(registry.match(compoundRequest('shell-two', 'shell.run', {
    path: 'D:/work', shell: 'powershell', script: 'Get-ChildItem C:/Temp | Select-Object Name', reviewComplexity: 'compound_shell',
  }), review));
  assert.equal(registry.match(compoundRequest('shell-drift', 'shell.run', {
    path: 'D:/work', shell: 'powershell', script: 'Get-ChildItem; Remove-Item file.txt', reviewComplexity: 'compound_shell',
  }), review), null);
  assert.equal(registry.match(compoundRequest('shell-bare-ampersand', 'shell.run', {
    path: 'D:/work', shell: 'powershell', script: 'Get-ChildItem & Remove-Item file.txt', reviewComplexity: 'compound_shell',
  }), review), null);
  registry.grant('allow_workspace', compoundRequest('process-shell-one', 'process.run', {
    path: 'D:/work', executable: 'powershell.exe',
    argv: ['-Command', 'Get-ChildItem'], reviewComplexity: 'compound_shell',
  }), review, 'operator');
  assert.equal(registry.match(compoundRequest('process-bare-ampersand', 'process.run', {
    path: 'D:/work', executable: 'powershell.exe',
    argv: ['-Command', 'Get-ChildItem & Remove-Item file.txt'], reviewComplexity: 'compound_shell',
  }), review), null);
});

test('preauthorization decisions reject request drift even when a caller retains the grant object', () => {
  const registry = new PreauthorizationRegistry();
  const original = request('original', 'a.txt');
  const grant = registry.grant('allow_session', original, context, 'operator');
  for (const drifted of [
    { ...request('authority', 'a.txt'), authorityId: 'authority-2' },
    { ...request('restriction', 'a.txt'), authorityRestrictionVersion: 1 },
    request('target', 'b.txt'),
  ]) {
    assert.throws(() => registry.decision(grant, drifted), { code: 'preauthorization_decision_invalid' });
  }
});

test('preauthorization choices exist only on the authenticated interactive contract', () => {
  const command = {
    version: '1.0', type: 'permission_decision', request_id: 'decision-1',
    permission_token: 'permission-1', tool_request_id: 'tool-1', choice: 'allow_workspace',
  };
  assert.equal(validateCommand(command, { interactive: true }).choice, 'allow_workspace');
  assert.throws(() => validateCommand(command), { code: 'unknown_control' });
});

test('operation preauthorization binds every transfer target and exact process argv', () => {
  const registry = new PreauthorizationRegistry();
  const transfer = compoundRequest('copy-one', 'fs.copy_file', {
    source: { path: 'D:/work/a.txt' }, destination: { path: 'D:/work/b.txt' },
  });
  const copyGrant = registry.grant('allow_session', transfer, context, 'operator');
  assert.equal(registry.match(compoundRequest('copy-two', 'fs.copy_file', {
    source: { path: 'D:/work/a.txt' }, destination: { path: 'D:/work/b.txt' },
  }), context)?.id, copyGrant.id);
  assert.equal(registry.match(compoundRequest('copy-drift', 'fs.copy_file', {
    source: { path: 'D:/work/a.txt' }, destination: { path: 'D:/work/c.txt' },
  }), context), null);

  const process = compoundRequest('process-one', 'process.run', {
    path: 'D:/work', executable: 'git', argv: ['status'],
  });
  const processGrant = registry.grant('allow_session', process, { definition: { sideEffect: 'unknown' } }, 'operator');
  assert.equal(registry.match(compoundRequest('process-drift', 'process.run', {
    path: 'D:/work', executable: 'git', argv: ['push'],
  }), { definition: { sideEffect: 'unknown' } }), null);
  assert.equal(registry.match(compoundRequest('process-two', 'process.run', {
    path: 'D:/work', executable: 'git', argv: ['status'],
  }), { definition: { sideEffect: 'unknown' } })?.id, processGrant.id);
});

function request(id, path) {
  return Object.freeze({
    id: `tool-${id}`, toolName: 'fs.write_text', args: { path }, resolved: { path: `D:/work/${path}` },
    authorityId: 'authority-1', authorityVersion: 1, policyVersion: 1, definitionVersion: 1,
    authorityRestrictionVersion: 0,
    workspaceRoot: 'D:/work', expiresAt: Date.now() + 60_000,
  });
}

function compoundRequest(id, toolName, resolved) {
  return Object.freeze({
    ...request(id, 'unused'), toolName, resolved,
  });
}
