// SPDX-License-Identifier: Apache-2.0
import { dirname, join, resolve } from 'node:path';
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
    NOTNATIVE_RUNTIME: 'service', NOTNATIVE_HARNESS: 'nna', NOTNATIVE_NNA_MODE: 'attach' });
  // The attached NNA child keeps the nnd_browser callback (F7): the desktop and
  // same-origin browser tabs are the capable broker clients; no bridge flag disables it.
}
function quote(path) {
  return '"' + path + '"';
}

/** F7 attach contract: publish the NND browser-callback descriptor to the
 *  already-running NNA integration host so nnd_browser installs for sessions
 *  created after registration. Best effort with bounded retries: a failed
 *  registration degrades to no browser tool, never to a failed service. The
 *  bounded outcome record lands in the service's own data root diagnostics. */
async function registerBrowserCallback(bootstrap, browserCallback, capability) {
  const attempts = [];
  const record = (outcome) => {
    try {
      const payload = JSON.stringify({ recorded_at: new Date().toISOString(), outcome,
        attempts }) + '\n';
      import('node:fs/promises').then((fs) => fs.mkdir(
        join(bootstrap.nnd_data_root, 'diagnostics'), { recursive: true })
        .then(() => fs.writeFile(join(bootstrap.nnd_data_root,
          'diagnostics/browser-callback-registration.json'), payload)))
        .catch(() => { /* diagnostics are best effort; the protocol channel stays clean */ });
    } catch { /* diagnostics are best effort; the protocol channel stays clean */ }
  };
  if (!browserCallback) {
    record('disabled');
    return 'disabled';
  }
  const endpoint = new URL(bootstrap.engine.endpoint).origin + '/internal/nnd/browser-callback';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(endpoint, { method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + bootstrap.engine.token,
          'x-nna-service-capability': capability },
        body: JSON.stringify(browserCallback), signal: AbortSignal.timeout(5000) });
      if (response.ok) {
        attempts.push({ attempt, status: response.status });
        record('registered');
        return 'registered';
      }
      const detail = await response.text().catch(() => '');
      attempts.push({ attempt, status: response.status, detail: detail.slice(0, 200) });
      console.error('NND browser callback registration attempt ' + attempt + ' failed: status '
        + response.status + ' ' + detail.slice(0, 200));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      attempts.push({ attempt, error: message });
      console.error('NND browser callback registration attempt ' + attempt + ' failed: ' + message);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  record('unregistered');
  return 'unregistered';
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
async function commands(frames, output, bootstrap, handle, setCapability) {
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
      // replace the current one for privileged harness requests; never echo
      // it back or write it to diagnostics.
      setCapability(command.capability);
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
  root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), launchTray } = {}) {
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
    // The renewable capability is the live authority grant (guide 02 L3):
    // the supervisor owns issuance/renewal; the harness adapter presents the
    // current one on every privileged request.
    let capability = bootstrap.engine.capability;
    const { startServer } = await import(pathToFileURL(installed.bundle).href);
    handle = await startServer({ nativeAuth: { installationId: bootstrap.installation_id,
      dataId: bootstrap.data_id, generation: bootstrap.generation, origin: new URL(bootstrap.ui_origin).origin },
    nativeHealthProof: { installationId: bootstrap.installation_id, dataId: bootstrap.data_id,
      generation: bootstrap.generation, origin: new URL(bootstrap.ui_origin).origin, key: bootstrap.health_key },
    nativeHarness: { ...bootstrap.engine, endpoint: new URL(bootstrap.engine.endpoint).origin, signal: controller.signal,
      capabilitySupplier: () => capability } });
    if (controller.signal.aborted) throw new Error('NND_SUPERVISED_INPUT_CLOSED');
    if (handle.port !== Number(new URL(bootstrap.ui_origin).port || 80) || !handle.nativeAuth || !handle.closed) {
      throw new Error('NND_SUPERVISED_START_FAILED');
    }
    clearTimeout(startupTimer);
    // Register the browser callback before the readiness frame so the first
    // session already sees nnd_browser (F7 attach contract).
    const registration = await registerBrowserCallback(bootstrap, handle.browserCallback, capability);
    if (registration !== 'registered') {
      console.error('NND browser callback ' + registration + '; the browser tool stays unavailable this generation');
    }
    await reply(output, { type: 'ready', protocol: '1.0', installation_id: bootstrap.installation_id,
      data_id: bootstrap.data_id, generation: bootstrap.generation, endpoint: bootstrap.ui_origin, version: installed.version });
    // Tray ownership contract: the tray is coupled to the SERVICE, never to
    // the desktop client. The service child spawns the lightweight tray host
    // (PowerShell NotifyIcon, no Chromium) after the readiness frame, and the
    // tray quits with the service. The service never launches the desktop:
    // a login auto-start (nnd enable) yields a headless service plus tray,
    // and `nnd start` must not race a Chromium boot against its own
    // readiness handshake. Fire-and-forget: a failed tray spawn never fails
    // the service. stdout stays protocol-only; diagnostics go to stderr.
    const tray = launchTray ?? (async () => {
      const { spawn } = await import('node:child_process');
      const powershell = join(process.env.SystemRoot ?? '', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const trayHost = join(root, 'scripts', 'nnd-tray-host.ps1');
      const child = spawn(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', trayHost,
        // Why: the tray host reads the discovery record at
        // <DataRoot>/runtime/nnd/current.json, which lives under the NNA data
        // root (identity.data_root), not under nnd_data_root (<data>/nnd, the
        // service's own state). Passing nnd_data_root made the tray's timer
        // never find the record and exit immediately (no tray icon).
        '-DataRoot', bootstrap.nna_data_root, '-InstallRoot', root, '-NodePath', process.execPath],
        // Neutral CWD: a live process locks its working directory, and the
        // tray must never pin the install root against cleanup or upgrade.
        { cwd: process.env.SystemRoot ?? null, windowsHide: true, stdio: 'ignore' });
      child.once('error', (error) => {
        console.error(`NND tray host launch failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      });
      child.unref();
    });
    tray().catch((error) => {
      console.error(`NND tray launch failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    });
    // The supervisor pushes fresh capabilities over this private channel; the
    // latest one is retained in memory only for privileged harness requests.
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
