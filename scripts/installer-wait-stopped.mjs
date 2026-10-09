// SPDX-License-Identifier: Apache-2.0
/** The native stop receipt is asynchronous. Uninstall waits for its exact
 * selected service lock to become free before taking the install guard. */
import { setTimeout as delay } from 'node:timers/promises';
import { realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const same = (left, right) => process.platform === 'win32'
  ? left.toLowerCase() === right.toLowerCase() : left === right;

export async function waitForSelectedNndStop(installRoot, dataRoot, timeoutMs = 30000) {
  if (!isAbsolute(installRoot) || !isAbsolute(dataRoot) || !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 1 || timeoutMs > 60000) throw new Error('selected_service_invalid');
  const nativeRoot = await realpath(installRoot);
  const selectedData = await realpath(dataRoot);
  const nativeModule = name => import(pathToFileURL(join(nativeRoot, 'installed', 'src', name)).href);
  const [{ readNndServiceIdentity }, { readNndServiceDiscovery }, { acquireNndServiceLock }] =
    await Promise.all([nativeModule('nnd-service-identity.js'), nativeModule('nnd-service-discovery.js'),
      nativeModule('nnd-service-lock.js')]);
  const identity = await readNndServiceIdentity(nativeRoot);
  if (!same(resolve(identity.data_root), selectedData)) throw new Error('selected_service_identity_changed');
  const deadline = Date.now() + timeoutMs;
  do {
    if (await readNndServiceDiscovery(identity) === null) {
      try {
        const lease = await acquireNndServiceLock({ dataRoot: identity.data_root });
        await lease.close();
        return { stopped: true, installation_id: identity.installation_id, data_id: identity.data_id };
      } catch (error) {
        if (error.code !== 'nnd_service_already_running') throw error;
      }
    }
    await delay(200);
  } while (Date.now() < deadline);
  throw new Error('selected_service_stop_timeout');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4) throw new Error('selected_service_usage_invalid');
    process.stdout.write(`${JSON.stringify(await waitForSelectedNndStop(process.argv[2], process.argv[3]))}\n`);
  } catch (error) {
    process.stderr.write(`nnd: ${error.message?.match(/^[a-z][a-z0-9_]{1,100}$/u)?.[0] ?? 'selected_service_stop_unverified'}\n`);
    process.exitCode = 1;
  }
}
