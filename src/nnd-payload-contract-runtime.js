// SPDX-License-Identifier: Apache-2.0
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { payloadError } from './nnd-payload-contract-files.js';
export function requiredNndPayloadFiles() {
  const required = ['packages/electron/main.mjs', 'packages/electron/preload.mjs', 'packages/electron/package.json',
    'packages/web/dist/index.html', 'packages/electron/dist-server/server.mjs', 'packages/electron/dist-server/settings-registry.json',
    'packages/electron/assets/tray-running.png', 'packages/electron/assets/tray-stopped.png'];
  const pty = 'packages/electron/dist-server/node_modules/node-pty/';
  required.push(...['package.json', 'lib/index.js', 'prebuilds/win32-x64/conpty.node', 'prebuilds/win32-x64/conpty_console_list.node',
    'prebuilds/win32-x64/pty.node', 'prebuilds/win32-x64/winpty-agent.exe', 'prebuilds/win32-x64/winpty.dll',
    'prebuilds/win32-x64/conpty/conpty.dll', 'prebuilds/win32-x64/conpty/OpenConsole.exe'].map((name) => pty + name));
  const runtime = 'packages/electron/node_modules/electron/dist/';
  required.push(...['electron.exe', 'version', 'resources/default_app.asar', 'locales/en-US.pak',
    'icudtl.dat', 'snapshot_blob.bin', 'v8_context_snapshot.bin', 'resources.pak', 'chrome_100_percent.pak', 'chrome_200_percent.pak',
    'd3dcompiler_47.dll', 'dxcompiler.dll', 'dxil.dll', 'ffmpeg.dll', 'vk_swiftshader.dll', 'vk_swiftshader_icd.json',
    'vulkan-1.dll', 'LICENSE', 'LICENSES.chromium.html'].map((name) => runtime + name));
  required.push(...['serve-installed.mjs','serve-supervised.mjs','supervised-protocol.mjs','installed-service-package.mjs','nnd-manifest-extensions.js','nnd-service-contract.js','nnd-contract-error.js'].map(name=>'scripts/'+name));
  required.push('packages/electron/install-mode.txt','packages/electron/build-stamp.json');
  required.push(...['browser-guest-policy.mjs', 'deep-links.mjs', 'desktop-boot.mjs', 'desktop-identity.mjs', 'desktop-pairing.mjs', 'desktop-password-login.mjs', 'desktop-updater.mjs', 'file-utilities.mjs', 'host-config.mjs', 'host-probe.mjs', 'ipc-face.mjs', 'local-paths.mjs', 'native-notifications.mjs', 'native-service-client.mjs', 'native-service-selection.mjs', 'relay-dev-tunnel.mjs', 'relay-pairing-bridge.mjs', 'renderer-recovery.mjs', 'shell-prefs.mjs', 'ssh-config-reader.mjs', 'ssh-instances.mjs', 'ssh-managed-bundle.mjs', 'ssh-managed-lifecycle.mjs', 'ssh-managed-runtime.mjs', 'ssh-managed-transfer.mjs', 'ssh-remote-command.mjs', 'ssh-transport.mjs', 'tray.mjs', 'trusted-origin.mjs', 'ui-protocol.mjs', 'updater-policy.mjs', 'window-state.mjs', 'windows-file-replace.mjs'].map(name=>'packages/electron/'+name));
  return required;
}
async function verifyWindowsX64(path) {
  const handle = await open(path, 'r');
  try {
    const header = Buffer.alloc(64), pe = Buffer.alloc(6);
    if ((await handle.read(header, 0, 64, 0)).bytesRead !== 64 || header.readUInt16LE(0) !== 0x5a4d) throw payloadError('payload-electron-platform-invalid');
    const offset = header.readUInt32LE(60);
    if (offset > 1024 * 1024 || (await handle.read(pe, 0, 6, offset)).bytesRead !== 6
      || pe.readUInt32LE(0) !== 0x00004550 || pe.readUInt16LE(4) !== 0x8664) throw payloadError('payload-electron-platform-invalid');
  } finally { await handle.close(); }
}

export async function assertPayloadRuntime(root,manifest) {
 const actual=new Set(manifest.files.map(file=>file.path));
 if(requiredNndPayloadFiles().some(path=>!actual.has(path))) throw payloadError('payload-runtime-incomplete');
 await verifyWindowsX64(join(root,'packages/electron/node_modules/electron/dist/electron.exe'));
}
