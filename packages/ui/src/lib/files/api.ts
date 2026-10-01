// SPDX-License-Identifier: Apache-2.0
/** Runtime-neutral files facade; host-specific transport lives in RuntimeAPIs. */
import type { FilesApi } from '../api/types.ts';
import { getRuntimeAPIs } from '../api/registry.ts';

export type { RuntimeFileEntry as FsEntry, RuntimeFileStat as FileStat } from '../api/types.ts';
export { FileReadError, FileWriteConflictError } from './errors.ts';

function files(): FilesApi {
  return getRuntimeAPIs().files;
}

export function listDirectory(directory: string, path = '.', force = false) {
  return files().listDirectory(directory, path, force);
}

export function searchWorkspaceFiles(directory: string, query: string, limit = 150) {
  return files().search(directory, query, limit);
}

export function readFileStat(directory: string, path: string, optional = false) {
  return files().readFileStat(directory, path, optional);
}

export function readFileText(directory: string, path: string, fresh = false) {
  return files().readFileText(directory, path, fresh);
}

export function writeFileText(directory: string, path: string, content: string, expectedContent?: string) {
  return files().writeFileText(directory, path, content, expectedContent);
}

export function rawAssetUrl(directory: string, path: string, download = false) {
  return files().rawAssetUrl(directory, path, download);
}

export function createDirectory(directory: string, path: string) {
  return files().createDirectory(directory, path);
}

export function deleteEntry(directory: string, path: string) {
  return files().deleteEntry(directory, path);
}

export function renameEntry(directory: string, oldPath: string, newPath: string) {
  return files().renameEntry(directory, oldPath, newPath);
}
