// SPDX-License-Identifier: Apache-2.0
import { isIP } from 'node:net';
const MAX_INSTANCES = 100;
const MAX_COMMAND_LENGTH = 4_096;
const MAX_SECRET_LENGTH = 4_096;
const MAX_FORWARD_COUNT = 64;
const VALUE_FLAGS = new Set(['-B', '-b', '-c', '-D', '-i', '-J', '-l', '-m', '-o', '-P', '-p', '-R']);
const BOOLEAN_FLAGS = new Set(['-4', '-6', '-A', '-a', '-C', '-K', '-k', '-X', '-x', '-Y', '-y']);
const FORWARD_TYPES = new Set(['local', 'remote', 'dynamic']);

function clean(value, max = 256) {
  if (typeof value !== 'string') return '';
  const result = value.trim();
  return result.length <= max && !/[\u0000-\u001f\u007f]/u.test(result) ? result : '';
}

function tokenize(command) {
  const tokens = [];
  let word = '';
  let quote = '';
  let escaped = false;
  let started = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (escaped) { word += char; escaped = false; started = true; continue; }
    if (char === '\\' && quote !== "'") {
      const next = command[index + 1];
      // Inside double quotes, a Windows path separator before a space is
      // part of the path ("C:\\Users\\A B\\key"), not shell escaping.
      if (next && ((quote === '' && /\s/u.test(next)) || next === '"' || next === "'" || next === '\\')) {
        escaped = true;
      } else {
        word += char;
      }
      started = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = '';
      else word += char;
      started = true;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; started = true; continue; }
    if (/\s/u.test(char)) {
      if (started) tokens.push(word);
      word = '';
      started = false;
      continue;
    }
    word += char;
    started = true;
  }
  if (escaped || quote) throw new Error('SSH command contains an unfinished escape or quote');
  if (started) tokens.push(word);
  return tokens;
}

function safeDestination(value) {
  return /^[A-Za-z0-9._:@%\[\]-]{1,256}$/u.test(value)
    && !value.startsWith('-') && !value.endsWith('@') && !value.startsWith('@');
}

function safeForwardHost(value, fallback = '127.0.0.1') {
  const host = clean(value, 256);
  if (!host) return fallback;
  if (host.startsWith('[') && host.endsWith(']') && isIP(host.slice(1, -1)) === 6) return host;
  if (isIP(host)) return host;
  const labels = host.split('.');
  if (labels.length > 1 && labels.every((label) => label.length > 0 && label.length <= 63
    && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u.test(label))) return host;
  return fallback;
}

function safeOption(flag, value) {
  if (!value || /[\u0000-\u001f\u007f]/u.test(value)) return false;
  if (flag !== '-o') return true;
  // OpenSSH accepts both `Name=value` and `Name value`. Blocking only the
  // equals form lets a quoted `ProxyCommand /bin/sh ...` reach ssh, where
  // OpenSSH executes it through a local shell.
  const option = value.trim().split(/[=\s]/u, 1)[0];
  return !/^(?:Control\w*|BatchMode|ProxyCommand|LocalCommand|PermitLocalCommand|KnownHostsCommand|PKCS11Provider|SecurityKeyProvider|RemoteCommand|SessionType|StdinNull)$/iu.test(option);
}

/** Strict SSH argv parser: exactly one destination, no remote command tail. */
export function parseDesktopSshCommand(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_COMMAND_LENGTH || /[\u0000-\u001f\u007f]/u.test(raw)) {
    throw new Error('SSH command is invalid or too long');
  }
  const tokens = tokenize(raw.trim());
  if (!tokens.length) throw new Error('SSH destination is required');
  const firstName = tokens[0].split(/[\\/]/u).at(-1)?.toLowerCase();
  if (firstName === 'ssh' || firstName === 'ssh.exe') tokens.shift();
  const args = [];
  let destination = null;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (destination !== null) throw new Error('SSH command must not include a remote command');
    if (!token.startsWith('-')) {
      if (!safeDestination(token)) throw new Error('SSH destination contains unsupported characters');
      destination = token;
      continue;
    }
    if (BOOLEAN_FLAGS.has(token)) { args.push(token); continue; }
    if (VALUE_FLAGS.has(token)) {
      const value = tokens[++index];
      if (!safeOption(token, value ?? '')) throw new Error(`SSH option ${token} is missing a safe value`);
      args.push(token, value);
      continue;
    }
    const attached = /^(-[BbcDilmPpR])(.+)$/u.exec(token);
    if (attached) {
      const [, flag, value] = attached;
      if (!safeOption(flag, value)) throw new Error(`SSH option ${flag} is unsafe`);
      args.push(token);
      continue;
    }
    if (token.startsWith('-o') && token.length > 2) {
      const value = token.slice(2);
      if (!safeOption('-o', value)) throw new Error('SSH option -o is unsafe');
      args.push(token);
      continue;
    }
    throw new Error(`SSH option ${token} is not allowed`);
  }
  if (!destination) throw new Error('SSH destination is required');
  return { destination, args };
}

function port(value) {
  return Number.isInteger(value) && value >= 1 && value <= 65_535 ? value : null;
}

function secret(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const enabled = input.enabled === true;
  const keep = enabled && input.store === 'settings' && typeof input.value === 'string'
    && input.value.length > 0 && input.value.length <= MAX_SECRET_LENGTH
    && !/[\u0000\r\n]/u.test(input.value);
  return {
    enabled, store: input.store === 'settings' ? 'settings' : 'never',
    ...(keep ? { value: input.value } : {}),
  };
}

function forwardList(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_FORWARD_COUNT) throw new Error('SSH forward list is invalid');
  const ids = new Set();
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !FORWARD_TYPES.has(entry.type)) {
      throw new Error('SSH forward entry is invalid');
    }
    const id = clean(entry.id, 128);
    if (!id || ids.has(id)) throw new Error('SSH forward ids must be present and unique');
    ids.add(id);
    const item = { id, enabled: entry.enabled === true, type: entry.type };
    item.localHost = safeForwardHost(entry.localHost);
    item.remoteHost = safeForwardHost(entry.remoteHost);
    const localPort = port(entry.localPort);
    const remotePort = port(entry.remotePort);
    if (localPort) item.localPort = localPort;
    if (remotePort) item.remotePort = remotePort;
    if (item.enabled && (entry.type === 'dynamic' ? !localPort : !localPort || !remotePort)) {
      throw new Error('Enabled SSH forwards require valid ports');
    }
    return item;
  });
}

export function sanitizeDesktopSshInstance(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('SSH instance is invalid');
  const id = clean(input.id, 128);
  if (!id || id === 'local' || !/^[A-Za-z0-9_-]+$/u.test(id)) throw new Error('SSH instance id is invalid');
  const sshCommand = clean(input.sshCommand, MAX_COMMAND_LENGTH);
  if (!sshCommand) throw new Error('SSH command is required');
  const sshParsed = parseDesktopSshCommand(sshCommand);
  const remote = input.remoteOpenchamber && typeof input.remoteOpenchamber === 'object' ? input.remoteOpenchamber : {};
  const local = input.localForward && typeof input.localForward === 'object' ? input.localForward : {};
  const auth = input.auth && typeof input.auth === 'object' ? input.auth : {};
  const timeout = Number.isFinite(input.connectionTimeoutSec)
    ? Math.min(600, Math.max(5, Math.round(input.connectionTimeoutSec))) : 60;
  const preferredPort = port(remote.preferredPort);
  const preferredLocalPort = port(local.preferredLocalPort);
  const instance = {
    id,
    sshCommand,
    sshParsed,
    connectionTimeoutSec: timeout,
    remoteOpenchamber: {
      mode: remote.mode === 'external' ? 'external' : 'managed',
      keepRunning: remote.keepRunning !== false,
      ...(preferredPort ? { preferredPort } : {}),
      bindHost: remote.bindHost === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1',
      installMethod: ['auto', 'npm', 'bun'].includes(remote.installMethod) ? remote.installMethod : 'auto',
      uploadBundleOverSsh: remote.uploadBundleOverSsh === true,
    },
    localForward: {
      ...(preferredLocalPort ? { preferredLocalPort } : {}),
      bindHost: ['localhost', '0.0.0.0'].includes(local.bindHost) ? local.bindHost : '127.0.0.1',
    },
    auth: {
      sshPassword: secret(auth.sshPassword),
      openchamberPassword: secret(auth.openchamberPassword),
    },
    portForwards: forwardList(input.portForwards),
  };
  const nickname = clean(input.nickname, 256);
  if (nickname) instance.nickname = nickname;
  return instance;
}

export function sanitizeDesktopSshInstances(value) {
  if (!Array.isArray(value) || value.length > MAX_INSTANCES) throw new Error('SSH instances list is invalid');
  const ids = new Set();
  const instances = value.map(sanitizeDesktopSshInstance);
  for (const instance of instances) {
    if (ids.has(instance.id)) throw new Error('SSH instance ids must be unique');
    ids.add(instance.id);
  }
  return instances;
}

/** Keep saved-host ids aligned with their SSH definitions during one prefs write. */
export function reconcileDesktopSshHosts(instancesInput, previousIdsInput, hostsConfig) {
  const instances = sanitizeDesktopSshInstances(instancesInput);
  const previousIds = new Set(previousIdsInput);
  const nextIds = new Set(instances.map((instance) => instance.id));
  if (hostsConfig.hosts.some((host) => nextIds.has(host.id) && !previousIds.has(host.id))) {
    throw new Error('desktop-ssh-host-id-collision');
  }
  const hosts = hostsConfig.hosts.filter((host) => !previousIds.has(host.id));
  for (const instance of instances) {
    hosts.push({
      id: instance.id, label: instance.nickname || instance.sshParsed.destination,
      url: 'http://127.0.0.1/', transport: 'ssh',
    });
  }
  return {
    instances,
    hostsConfig: {
      hosts,
      defaultHostId: hostsConfig.defaultHostId && previousIds.has(hostsConfig.defaultHostId)
        && !nextIds.has(hostsConfig.defaultHostId) ? 'local' : hostsConfig.defaultHostId,
      initialHostChoiceCompleted: hostsConfig.initialHostChoiceCompleted,
    },
  };
}
