// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { readNndServiceIdentity } from './nnd-service-identity.js';
import { readNndServiceDiscovery } from './nnd-service-discovery.js';
import { requestNndController } from './nnd-service-controller.js';
import { startNndSupervisor } from './nnd-service-supervisor.js';
import { childEnvironment } from './nnd-service-child.js';
import { userDataPaths, ensureUserDataPaths } from './product.js';
import { ContractError } from './ids.js';
import { loadManagedProviderCredentials } from './provider/bootstrap.js';
import { loadManagedMcpCredentials } from './mcp-credentials.js';
import { nndServiceCapabilities } from './nnd-service-attach.js';
import { runNndInstallGuard } from './nnd-install-guard.js';
import { runNndMigration } from './nnd-migration.js';
import { stageNndInstallSlot, recoverNndInstallSlot } from './nnd-install-slots.js';

export async function runNndServiceCommand(args, options = {}) {
  const [action, root] = args;
  const actions = ['start', 'run', 'status', 'stop', 'ui-ticket', 'attach', 'capabilities', 'install-guard', 'migrate', 'migration-recover'];
  const valid = action === 'stage-payload' ? args.length === 4
    : action === 'stage-recover' ? args.length >= 2 && args.length <= 3 : args.length === 2 && actions.includes(action);
  if (!valid) {
    throw new ContractError('nnd_command_invalid', 'Use nnd service ACTION INSTALL_ROOT, stage-payload INSTALL_ROOT PAYLOAD_ROOT OPERATION_UUID, or stage-recover INSTALL_ROOT [OPERATION_UUID]');
  }
  const identity = await readNndServiceIdentity(root);
  if (action === 'stage-payload') return stageNndInstallSlot(identity, { source: args[2], operationId: args[3], signal: options.signal });
  if (action === 'stage-recover') return recoverNndInstallSlot(identity, { operationId: args[2], signal: options.signal });
  if (['migrate', 'migration-recover'].includes(action)) {
    return runNndMigration(identity, userDataPaths({ environment: { NNA_HOME: identity.data_root } }), action);
  }
  if (action === 'capabilities') return nndServiceCapabilities(identity);
  if (action === 'install-guard') return runNndInstallGuard(identity, options);
  if (action === 'run') return runForeground(identity, options);
  if (action === 'start') return startBackground(identity);
  const record = await readNndServiceDiscovery(identity);
  if (!record) throw new ContractError('nnd_service_not_running', 'NND service has no active controller');
  return requestNndController(record, action);
}
async function runForeground(identity, options) {
  const paths = await ensureUserDataPaths(userDataPaths({ environment: { NNA_HOME: identity.data_root } }));
  await loadManagedProviderCredentials(paths);
  await loadManagedMcpCredentials(paths);
  const supervisor = await startNndSupervisor(identity, paths, options);
  const stop = () => { void supervisor.stop().catch(() => {}); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  options.signal?.addEventListener('abort', stop, { once: true });
  if (options.signal?.aborted) stop();
  (options.output ?? process.stdout).write(`${JSON.stringify(supervisor.status())}\n`);
  try {
    const result = await supervisor.stopped;
    if (result?.error) throw result.error;
    return { stopped: true };
  } finally {
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    options.signal?.removeEventListener('abort', stop);
  }
}
async function startBackground(identity) {
  const previous = await readNndServiceDiscovery(identity);
  if (previous) {
    try { return await requestNndController(previous, 'status'); }
    catch { throw new ContractError('nnd_owner_unverified', 'Existing NND controller is unavailable; use foreground run for verified recovery'); }
  }
  const child = spawn(identity.node, [identity.cli_path, 'nnd', 'service', 'run', identity.install_root], {
    cwd: identity.install_root, env: nativeEnvironment(identity), detached: true, windowsHide: true, stdio: 'ignore',
  });
  let failure;
  child.on('error', (error) => { failure = error; });
  child.on('exit', () => { failure ??= new Error('Supervisor exited before readiness'); });
  child.unref();
  for (let count = 0; count < 100; count += 1) {
    if (failure) throw new ContractError('nnd_service_crashed', 'NND supervisor failed to start', { cause: failure });
    const record = await readNndServiceDiscovery(identity);
    if (record) return requestNndController(record, 'status');
    await delay(200);
  }
  // Security: never infer ownership from a discovered PID or kill an unrelated service.
  throw new ContractError('nnd_start_timeout', 'NND startup did not publish its controller within the time bound');
}

function nativeEnvironment(identity) {
  // Compatibility: native provider/MCP environment credentials remain in the native process only.
  const environment = { ...process.env, ...childEnvironment(identity) };
  for (const key of Object.keys(environment)) {
    if (/^(NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE|NNA_INTEGRATION_TOKEN|NNA_PRINCIPAL|NND_.*)$/iu.test(key)) delete environment[key];
  }
  return environment;
}
