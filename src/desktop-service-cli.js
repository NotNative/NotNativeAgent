// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { readDesktopServiceIdentity } from './desktop-service-identity.js';
import { readDesktopServiceDiscovery } from './desktop-service-discovery.js';
import { requestDesktopController } from './desktop-service-controller.js';
import { startDesktopSupervisor } from './desktop-service-supervisor.js';
import { childEnvironment } from './desktop-service-child.js';
import { userDataPaths, ensureUserDataPaths } from './product.js';
import { ContractError } from './ids.js';
import { loadManagedProviderCredentials } from './provider/bootstrap.js';
import { loadManagedMcpCredentials } from './mcp-credentials.js';
import { desktopServiceCapabilities } from './desktop-service-attach.js';
import { runDesktopInstallGuard } from './desktop-install-guard.js';
import { runDesktopMigration } from './desktop-migration.js';
import { stageDesktopInstallSlot, recoverDesktopInstallSlot } from './desktop-install-slots.js';
import { preflightDesktopActivation, recoverDesktopActivationPreparationCommand, activateDesktopSlotCommand } from './desktop-activation-cli.js';

export async function runDesktopServiceCommand(args, options = {}) {
  const [action, root] = args;
  const actions = ['start', 'run', 'status', 'stop', 'ui-ticket', 'attach', 'capabilities', 'install-guard', 'migrate', 'migration-recover'];
  const valid = action === 'stage-payload' ? args.length === 4
    : action === 'stage-recover' ? args.length >= 2 && args.length <= 3 : args.length === 2 && actions.includes(action);
  const activationValid = action === 'activation-preflight' ? args.length === 4
    : action === 'activate-slot' ? args.length === 4
      : action === 'activation-preparation-recover' ? args.length === 3 : false;
  if (!valid && !activationValid) {
    throw new ContractError('desktop_command_invalid', 'Use desktop service ACTION INSTALL_ROOT, stage-payload INSTALL_ROOT PAYLOAD_ROOT OPERATION_UUID, stage-recover INSTALL_ROOT [OPERATION_UUID], activation-preflight INSTALL_ROOT STAGE_UUID ACTIVATION_UUID, activate-slot INSTALL_ROOT STAGE_UUID ACTIVATION_UUID, or activation-preparation-recover INSTALL_ROOT ACTIVATION_UUID');
  }
  const identity = await readDesktopServiceIdentity(root);
  if (action === 'activation-preflight') return preflightDesktopActivation(identity,
    { stageOperationId: args[2], operationId: args[3], signal: options.signal });
  if (action === 'activate-slot') return activateDesktopSlotCommand(identity,
    { stageOperationId: args[2], operationId: args[3], signal: options.signal, output: options.output });
  if (action === 'activation-preparation-recover') return recoverDesktopActivationPreparationCommand(identity,
    { operationId: args[2] });
  if (action === 'stage-payload') return stageDesktopInstallSlot(identity, { source: args[2], operationId: args[3], signal: options.signal });
  if (action === 'stage-recover') return recoverDesktopInstallSlot(identity, { operationId: args[2], signal: options.signal });
  if (['migrate', 'migration-recover'].includes(action)) {
    return runDesktopMigration(identity, userDataPaths({ environment: { NNA_HOME: identity.data_root } }), action);
  }
  if (action === 'capabilities') return desktopServiceCapabilities(identity);
  if (action === 'install-guard') return runDesktopInstallGuard(identity, options);
  if (action === 'run') return runForeground(identity, options);
  if (action === 'start') return startBackground(identity);
  const record = await readDesktopServiceDiscovery(identity);
  if (!record) throw new ContractError('desktop_service_not_running', 'desktop service has no active controller');
  return requestDesktopController(record, action);
}
async function runForeground(identity, options) {
  const paths = await ensureUserDataPaths(userDataPaths({ environment: { NNA_HOME: identity.data_root } }));
  await loadManagedProviderCredentials(paths);
  await loadManagedMcpCredentials(paths);
  const supervisor = await startDesktopSupervisor(identity, paths, options);
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
  const previous = await readDesktopServiceDiscovery(identity);
  if (previous) {
    try { return await requestDesktopController(previous, 'status'); }
    catch { throw new ContractError('desktop_owner_unverified', 'Existing desktop controller is unavailable; use foreground run for verified recovery'); }
  }
  const child = spawn(identity.node, [identity.cli_path, 'desktop', 'service', 'run', identity.install_root], {
    cwd: identity.install_root, env: nativeEnvironment(identity), detached: true, windowsHide: true, stdio: 'ignore',
  });
  let failure;
  child.on('error', (error) => { failure = error; });
  child.on('exit', () => { failure ??= new Error('Supervisor exited before readiness'); });
  child.unref();
  for (let count = 0; count < 100; count += 1) {
    if (failure) throw new ContractError('desktop_service_crashed', 'desktop supervisor failed to start', { cause: failure });
    const record = await readDesktopServiceDiscovery(identity);
    if (record) return requestDesktopController(record, 'status');
    await delay(200);
  }
  // Security: never infer ownership from a discovered PID or kill an unrelated service.
  throw new ContractError('desktop_start_timeout', 'desktop startup did not publish its controller within the time bound');
}

export function nativeEnvironment(identity) {
  // Compatibility: native provider/MCP environment credentials remain in the native process only.
  const environment = { ...process.env, ...childEnvironment(identity) };
  for (const key of Object.keys(environment)) {
    if (/^(NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE|NNA_INTEGRATION_TOKEN|NNA_PRINCIPAL|DESKTOP_.*)$/iu.test(key)) delete environment[key];
  }
  return environment;
}
