// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import fsConstants from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function message(error) {
  if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
  if (error?.code === 'EACCES' || error?.code === 'EPERM') return 'is not accessible';
  return `could not be checked: ${error instanceof Error ? error.message : String(error)}`;
}

export async function validateLocalPath(rawPath, label = 'Path', {
  fileSystem = fs, constants = fsConstants.constants,
} = {}) {
  if (typeof rawPath !== 'string' || rawPath.trim() === '') throw new Error(`${label} is required`);
  if (rawPath.length > 32_768) throw new Error(`${label} is too long`);
  const resolved = path.resolve(rawPath.trim());
  let stats;
  try { stats = await fileSystem.stat(resolved); }
  catch (error) {
    const detail = message(error);
    if (detail === null) throw new Error(`${label} does not exist: ${resolved}`);
    if (detail === 'is not accessible') throw new Error(`${label} ${detail}: ${resolved}`);
    throw new Error(`${label} ${detail}`);
  }
  if (!stats.isDirectory() && !stats.isFile()) throw new Error(`${label} is not a regular file or directory: ${resolved}`);
  const accessMode = stats.isDirectory()
    ? constants.R_OK | constants.X_OK
    : constants.R_OK;
  try { await fileSystem.access(resolved, accessMode); }
  catch (error) {
    if (error?.code === 'EACCES' || error?.code === 'EPERM') throw new Error(`${label} is not accessible: ${resolved}`);
    throw new Error(`${label} could not be checked: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { path: resolved, stats };
}

export function unsupportedAppSpecificOpenError(kind, platform = process.platform) {
  const names = { win32: 'Windows', linux: 'Linux', darwin: 'macOS' };
  const platformName = names[platform] ?? platform;
  return `Opening ${kind} in a specific app is not supported on ${platformName} yet. Use the default open action instead.`;
}

export function createLocalPathUtilities({ shell, fileSystem = fs, constants = fsConstants.constants,
  platform = process.platform, openWithApp = execFileAsync } = {}) {
  if (!shell || typeof shell.openPath !== 'function' || typeof shell.showItemInFolder !== 'function') {
    throw new TypeError('Electron shell path operations are required');
  }
  return {
    async open(rawPath, app) {
      const target = await validateLocalPath(rawPath, 'Path', { fileSystem, constants });
      if (app !== undefined && app !== null && app !== '') {
        if (platform !== 'darwin') throw new Error(unsupportedAppSpecificOpenError(target.stats.isDirectory() ? 'folder' : 'file', platform));
        if (typeof app !== 'string' || app.trim() === '' || app.trim().startsWith('-') || app.length > 512) {
          throw new Error('App name is invalid');
        }
        await openWithApp('open', ['-a', app.trim(), '--', target.path], { windowsHide: true });
      } else {
        const error = await shell.openPath(target.path);
        if (typeof error === 'string' && error !== '') throw new Error(error);
      }
      return null;
    },
    async reveal(rawPath) {
      const target = await validateLocalPath(rawPath, 'Path', { fileSystem, constants });
      if (target.stats.isDirectory()) {
        const error = await shell.openPath(target.path);
        if (typeof error === 'string' && error !== '') throw new Error(error);
      } else {
        shell.showItemInFolder(target.path);
      }
      return null;
    },
  };
}
