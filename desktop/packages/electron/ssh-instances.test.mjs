// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDesktopSshCommand, reconcileDesktopSshHosts, sanitizeDesktopSshInstance, sanitizeDesktopSshInstances } from './ssh-instances.mjs';

const instance = (overrides = {}) => ({
  id: 'ssh-studio', sshCommand: 'ssh -p 2222 -i "/keys/work identity" dev@studio.example',
  connectionTimeoutSec: 30,
  remoteOpenchamber: { mode: 'managed', keepRunning: true, bindHost: '127.0.0.1', installMethod: 'auto' },
  localForward: { bindHost: '127.0.0.1' }, auth: {}, portForwards: [], ...overrides,
});

test('parses one SSH destination and preserves valued arguments without a shell', () => {
  assert.deepEqual(parseDesktopSshCommand('ssh -p 2222 -i "/keys/work identity" dev@studio.example'), {
    destination: 'dev@studio.example', args: ['-p', '2222', '-i', '/keys/work identity'],
  });
  assert.deepEqual(parseDesktopSshCommand('C:\\Windows\\System32\\OpenSSH\\ssh.exe -p2222 studio'), {
    destination: 'studio', args: ['-p2222'],
  });
  assert.deepEqual(parseDesktopSshCommand('ssh -oStrictHostKeyChecking=accept-new studio'), {
    destination: 'studio', args: ['-oStrictHostKeyChecking=accept-new'],
  });
  assert.deepEqual(parseDesktopSshCommand('"C:\\Program Files\\OpenSSH\\ssh.exe" -i "C:\\Users\\My Name\\.ssh\\id_ed25519" studio'), {
    destination: 'studio', args: ['-i', 'C:\\Users\\My Name\\.ssh\\id_ed25519'],
  });
});

test('rejects command tails, unsafe flags, unsafe OpenSSH options, and malformed quoting', () => {
  for (const command of [
    'ssh -N studio', 'ssh -S /tmp/control studio', 'ssh -o ControlMaster=yes studio',
    'ssh -oProxyCommand=evil studio', 'ssh -o "ProxyCommand /bin/sh -c id" studio',
    'ssh -o "LocalCommand /bin/sh -c id" studio', 'ssh -o "KnownHostsCommand /bin/sh" studio',
    'ssh -o "RemoteCommand id" studio', 'ssh -oRemoteCommand=id studio',
    'ssh -o "SecurityKeyProvider /tmp/provider.so" studio', 'ssh -I /tmp/provider.so studio',
    'ssh -I/tmp/provider.so studio', 'ssh -F /tmp/ssh_config studio', 'ssh -F/tmp/ssh_config studio',
    'ssh studio whoami', 'ssh -p', 'ssh "studio', 'ssh -- studio',
  ]) assert.throws(() => parseDesktopSshCommand(command), undefined, command);
});

test('normalizes persisted instance fields and recomputes sshParsed from the command', () => {
  const result = sanitizeDesktopSshInstance(instance({
    nickname: ' Studio ', connectionTimeoutSec: 1_000,
    sshParsed: { destination: 'attacker', args: ['-F', 'evil'] },
    unknown: 'dropped', auth: { sshPassword: { enabled: true, store: 'never', value: 'do-not-persist' } },
  }));
  assert.equal(result.nickname, 'Studio');
  assert.equal(result.connectionTimeoutSec, 600);
  assert.deepEqual(result.sshParsed, { destination: 'dev@studio.example', args: ['-p', '2222', '-i', '/keys/work identity'] });
  assert.deepEqual(result.auth.sshPassword, { enabled: true, store: 'never' });
  assert.equal('unknown' in result, false);
});

test('persists secrets only when explicitly enabled for settings storage', () => {
  const result = sanitizeDesktopSshInstance(instance({ auth: {
    sshPassword: { enabled: true, store: 'settings', value: 'ssh-secret' },
    openchamberPassword: { enabled: false, store: 'settings', value: 'disabled-secret' },
  } }));
  assert.deepEqual(result.auth.sshPassword, { enabled: true, store: 'settings', value: 'ssh-secret' });
  assert.deepEqual(result.auth.openchamberPassword, { enabled: false, store: 'settings' });
  assert.equal(JSON.stringify(result).includes('disabled-secret'), false);
});

test('rejects invalid identities, duplicate ids, duplicate forwards, and enabled forwards without ports', () => {
  assert.throws(() => sanitizeDesktopSshInstance(instance({ id: 'local' })), /id is invalid/u);
  assert.throws(() => sanitizeDesktopSshInstances([instance(), instance()]), /unique/u);
  assert.throws(() => sanitizeDesktopSshInstance(instance({ portForwards: [
    { id: 'same', type: 'dynamic', enabled: true, localPort: 1080 },
    { id: 'same', type: 'dynamic', enabled: true, localPort: 1081 },
  ] })), /unique/u);
  assert.throws(() => sanitizeDesktopSshInstance(instance({ portForwards: [
    { id: 'bad', type: 'local', enabled: true, localPort: 8080 },
  ] })), /require valid ports/u);
});

test('defaults forwarding hosts safely and rejects forwarding-spec delimiter injection', () => {
  const result = sanitizeDesktopSshInstance(instance({ portForwards: [
    { id: 'safe', type: 'local', enabled: true, localPort: 8080, remotePort: 80 },
    { id: 'bad-local', type: 'local', enabled: false, localHost: '0.0.0.0:9000', localPort: 8081, remoteHost: 'host.example:22', remotePort: 80 },
    { id: 'ipv6', type: 'remote', enabled: false, localHost: '[::1]', remoteHost: '[2001:db8::1]', localPort: 8082, remotePort: 80 },
  ] }));
  assert.equal(result.portForwards[0].localHost, '127.0.0.1');
  assert.equal(result.portForwards[0].remoteHost, '127.0.0.1');
  assert.equal(result.portForwards[1].localHost, '127.0.0.1');
  assert.equal(result.portForwards[1].remoteHost, '127.0.0.1');
  assert.equal(result.portForwards[2].localHost, '[::1]');
  assert.equal(result.portForwards[2].remoteHost, '[2001:db8::1]');
});

test('reconciles SSH definitions with saved-host ids and resets a removed default', () => {
  const current = [
    { id: 'ssh-old', label: 'Old SSH', url: 'http://127.0.0.1:5678', clientToken: 'old-token' },
    { id: 'paired-host', label: 'Paired', url: 'https://paired.example' },
  ];
  const result = reconcileDesktopSshHosts([instance({ id: 'ssh-new' })], ['ssh-old'], {
    hosts: current, defaultHostId: 'ssh-old', initialHostChoiceCompleted: true,
  });
  assert.deepEqual(result.hostsConfig, {
    hosts: [
      current[1], { id: 'ssh-new', label: 'dev@studio.example', url: 'http://127.0.0.1/', transport: 'ssh' },
    ],
    defaultHostId: 'local', initialHostChoiceCompleted: true,
  });
  assert.equal(result.instances[0].id, 'ssh-new');
});

test('refuses collisions with non-SSH saved hosts without changing the catalog', () => {
  assert.throws(() => reconcileDesktopSshHosts([instance()], [], {
    hosts: [{ id: 'ssh-studio', label: 'Paired', url: 'https://paired.example' }],
    defaultHostId: 'ssh-studio', initialHostChoiceCompleted: true,
  }), /desktop-ssh-host-id-collision/u);
});
