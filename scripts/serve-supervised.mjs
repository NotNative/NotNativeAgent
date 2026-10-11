// SPDX-License-Identifier: Apache-2.0
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateInstalledNndService } from './installed-service-package.mjs';
import { readPrivateFrames, validateBootstrap, validateControl } from './supervised-protocol.mjs';

function deadline(promise, milliseconds) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('NND_SUPERVISED_TIMEOUT')), milliseconds);
  })]).finally(() => clearTimeout(timer));
}
function configureEnvironment(bootstrap, installed) {
  for (const key of Object.keys(process.env)) {
    if (/^(NNA_|NOTNATIVE_|NODE_OPTIONS$|NODE_PATH$)/iu.test(key)) delete process.env[key];
  }
  const ui = new URL(bootstrap.ui_origin);
  Object.assign(process.env, { NOTNATIVE_HOST: ui.hostname.replace(/^\[|\]$/gu, ''),
    NOTNATIVE_PORT: ui.port || '80', NOTNATIVE_DATA_DIR: bootstrap.nnd_data_root,
    NOTNATIVE_DIST_DIR: installed.dist, NOTNATIVE_APP_VERSION: installed.packageVersion,
    NOTNATIVE_RUNTIME: 'service', NOTNATIVE_HARNESS: 'nna', NOTNATIVE_NNA_MODE: 'attach',
    NOTNATIVE_BROWSER_BRIDGE: 'disabled' });
}
async function reply(output, frame) {
  await deadline(new Promise((resolve, reject) => {
    output.write(`${JSON.stringify(frame)}\n`, (error) => error ? reject(new Error('NND_SUPERVISED_OUTPUT_FAILED')) : resolve());
  }), 5000);
}
async function stop(handle) {
  if (!handle) return;
  handle.dispose();
  await deadline(handle.closed, 5000);
}
async function commands(frames, output, bootstrap, handle, onCapability) {
  for (;;) {
    const frame = await frames.next();
    if (!frame) return;
    const command = validateControl(frame, bootstrap.generation);
    const base = { protocol: '1.0', generation: bootstrap.generation, request_id: command.request_id };
    if (command.type === 'stop') {
      await stop(handle);
      await reply(output, { type: 'stopped', ...base });
      return;
    }
    if (command.type === 'apply_capability') {
      // The supervisor owns the renewable capability (execution guide 02 L3):
      // store the fresh capability for privileged harness requests; never
      // echo it back or write it to diagnostics.
      onCapability(command.capability);
      await reply(output, { type: 'applied', ...base });
      continue;
    }
    let ticket;
    try { ticket = handle.nativeAuth.issueTicket(); }
    catch { await reply(output, { type: 'error', ...base, code: 'NND_UI_TICKET_UNAVAILABLE' }); continue; }
    await reply(output, { type: 'ui_ticket', ...base, ticket: ticket.ticket, expires_at: ticket.expiresAt });
  }
}

export async function runSupervisedService({ input = process.stdin, output = process.stdout,
  root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), launchDesktop } = {}) {
  const controller = new AbortController();
  let handle;
  // This standalone attach-only child owns no engine; exit is the final bound
  // when an imported subsystem ignores cancellation or listener teardown.
  let watchdog;
  const armExit = () => { watchdog ??= setTimeout(() => process.exit(1), 5000); };
  const startupTimer = setTimeout(() => { end(); armExit(); }, 30_000);
  let frames;
  const end = () => { controller.abort(); armExit(); handle?.dispose(); frames?.cancel(); };
  frames = readPrivateFrames(input, end);
  process.once('SIGINT', end); process.once('SIGTERM', end);
  // Ordinary server diagnostics must never contaminate the private protocol.
  const original = { log: console.log, info: console.info, debug: console.debug };
  console.log = console.info = console.debug = () => {};
  try {
    const bootstrap = await validateBootstrap(await deadline(frames.next(), 15_000));
    const installed = await validateInstalledNndService(root);
    if (controller.signal.aborted) throw new Error('NND_SUPERVISED_INPUT_CLOSED');
    configureEnvironment(bootstrap, installed);
    const { startServer } = await import(pathToFileURL(installed.bundle).href);
    handle = await startServer({ nativeAuth: { installationId: bootstrap.installation_id,
      dataId: bootstrap.data_id, generation: bootstrap.generation, origin: new URL(bootstrap.ui_origin).origin },
    nativeHealthProof: { installationId: bootstrap.installation_id, dataId: bootstrap.data_id,
      generation: bootstrap.generation, origin: new URL(bootstrap.ui_origin).origin, key: bootstrap.health_key },
    nativeHarness: { ...bootstrap.engine, endpoint: new URL(bootstrap.engine.endpoint).origin, signal: controller.signal } });
    if (controller.signal.aborted) throw new Error('NND_SUPERVISED_INPUT_CLOSED');
    if (handle.port !== Number(new URL(bootstrap.ui_origin).port || 80) || !handle.nativeAuth || !handle.closed) {
      throw new Error('NND_SUPERVISED_START_FAILED');
    }
    clearTimeout(startupTimer);
    await reply(output, { type: 'ready', protocol: '1.0', installation_id: bootstrap.installation_id,
      data_id: bootstrap.data_id, generation: bootstrap.generation, endpoint: bootstrap.ui_origin, version: installed.version });
    // The tray is permanently linked to the service: whatever starts the
    // service (CLI, shortcut, login script) also brings up the desktop app
    // attached to this generation. Fire-and-forget so a failed launch never
    // fails the service, and Electron's single-instance lock dedups the
    // redundant launch the shortcut performs. stdout stays protocol-only;
    // launch diagnostics go to stderr.
    const launch = launchDesktop ?? (async () => {
      const { launchSelectedDesktop } = await import('./launch-selected-desktop.mjs');
      return launchSelectedDesktop(root);
    });
    launch().catch((error) => {
      console.error(`NND desktop launch failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    });
    // The supervisor pushes fresh capabilities over this private channel; the
    // latest one is retained in memory only for privileged harness requests.
    let capability = null;
    await commands(frames, output, bootstrap, handle, (value) => { capability = value; });
  } catch {
    await reply(output, { type: 'failed', protocol: '1.0', code: 'NND_SUPERVISED_FAILED' }).catch(() => {});
    process.exitCode = 1;
  } finally {
    clearTimeout(startupTimer); armExit(); controller.abort(); frames.dispose();
    process.off('SIGINT', end); process.off('SIGTERM', end);
    try { await stop(handle); clearTimeout(watchdog); } finally { Object.assign(console, original); }
  }
}
