// SPDX-License-Identifier: Apache-2.0
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, appendFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveActiveNndPackage } from './resolve-active-nnd-package.mjs';
import { attachNativeService, probeNativeAttach, requestNativeServiceStop, requestNativeServiceStatus, readSelectedNativeRuntime } from '../packages/electron/native-service-client.mjs';
const execute = promisify(execFile);
export async function runTrayAction(anchor, action, ports = {}) {
  if (!['browser', 'restart'].includes(action)) throw new Error('tray-action-invalid');
  const plan = await (ports.resolve ?? resolveActiveNndPackage)(join(anchor, 'nna-service-selection.json'), anchor);
  const selection = { installRoot: plan.nnaInstallRoot, installation_id: plan.installationId,
    data_id: plan.dataId, incarnation_id: plan.incarnationId };
  const attach = ports.attach ?? attachNativeService;
  if (action === 'browser') {
    const attached = await attach(selection);
    const url = `${attached.origin}/#nna-access=${attached.ticket}`;
    await (ports.open ?? (url => execute('rundll32.exe', ['url.dll,FileProtocolHandler', url], { windowsHide: true, timeout: 10000 })))(url);
    return { opened: true };
  }
  const before = await (ports.probe ?? probeNativeAttach)(selection);
  await (ports.stop ?? requestNativeServiceStop)(selection);
  let stopped = false;
  const deadline = Date.now() + 30_000;
  for (let count = 0; count < 150 && Date.now() < deadline; count += 1) {
    try {
      const status = await (ports.status ?? requestNativeServiceStatus)(selection);
      if (status.instance_id !== before.generation) throw new Error('nnd_restart_generation_changed');
    }
    catch (error) { if (error.message === 'nnd_service_not_running') { stopped = true; break; } throw error; }
    await (ports.delay ?? delay)(200);
  }
  if (!stopped) throw new Error('nnd_stop_timeout');
  const after = await attach(selection);
  if (after.generation === before.generation) throw new Error('nnd_restart_generation_unchanged');
  return { restarted: true, generation: after.generation };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const anchor = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  try {
    if (process.argv.length !== 3) throw new Error('tray-action-invalid');
    await runTrayAction(anchor, process.argv[2]);
  } catch (error) {
    const code = /^[a-z][a-z0-9_-]{1,100}$/u.test(error.message) ? error.message : 'tray_action_failed';
    try {
      const plan = await resolveActiveNndPackage(join(anchor, 'nna-service-selection.json'), anchor);
      const runtime = readSelectedNativeRuntime(plan.nnaInstallRoot), logs = join(runtime.dataRoot, 'logs');
      await mkdir(logs, { recursive: true }); await appendFile(join(logs, 'tray-actions.log'), `${new Date().toISOString()} ${process.argv[2]} ${code}\n`);
    } catch { /* A failed installation selection must not choose another log root. */ }
    await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.MessageBox]::Show('NNA could not complete the tray action. See tray-actions.log in your NNA logs directory.','NNA')"], { windowsHide: true }).catch(() => undefined);
    process.exitCode = 1;
  }
}
