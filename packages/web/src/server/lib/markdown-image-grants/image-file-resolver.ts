// SPDX-License-Identifier: Apache-2.0
/** Resolve and validate assistant-authorised local image destinations. */

import { constants, open, realpath } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { mintOutsideFileGrant } from '../fs/outside-file-grants.ts';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export type PreparedImageFile =
  | { status: 'ready'; path: string; outsideFileGrant?: string; expiresAt?: number }
  | { status: 'missing' | 'pruned' | 'oversized' | 'unsupported' | 'error' };

type RealPath = { kind: 'real'; path: string } | { kind: 'missing' } | { kind: 'error' };

export async function prepareImageFile(
  source: string,
  workspaceRoot: string,
  approvedTempRoot: string,
): Promise<PreparedImageFile> {
  const candidate = resolve(workspaceRoot, source);
  const lexicalRoot = await resolveRealPath(workspaceRoot);
  if (lexicalRoot.kind !== 'real') return { status: 'error' };
  if (contains(lexicalRoot.path, candidate)) {
    const realPath = await resolveRealPath(candidate);
    if (realPath.kind !== 'real') return { status: realPath.kind };
    if (!contains(lexicalRoot.path, realPath.path)) return { status: 'error' };
    return validateImage(realPath.path, false);
  }
  const tempRoot = await resolveRealPath(approvedTempRoot);
  const realPath = await resolveRealPath(candidate);
  if (realPath.kind !== 'real') return { status: realPath.kind };
  if (tempRoot.kind !== 'real' || !contains(tempRoot.path, realPath.path)) return { status: 'error' };
  return validateImage(realPath.path, true);
}

async function validateImage(path: string, outside: boolean): Promise<PreparedImageFile> {
  const opened = await openImage(path);
  if (opened.kind === 'missing') return { status: 'missing' };
  if (opened.kind !== 'open') return { status: 'error' };
  try {
    const stats = await opened.file.stat();
    if (!stats.isFile()) return { status: 'error' };
    if (stats.size > MAX_IMAGE_BYTES) return { status: 'oversized' };
    const header = Buffer.alloc(12, 0);
    const read = await opened.file.read(header, 0, header.length, 0);
    if (!isImageSignature(header.subarray(0, read.bytesRead))) return { status: 'unsupported' };
    if (!outside) return { status: 'ready', path };
    const grant = mintOutsideFileGrant(path);
    if (grant === null) return { status: 'error' };
    return { status: 'ready', path, outsideFileGrant: grant.token, expiresAt: grant.expiresAt };
  } catch {
    return { status: 'error' };
  } finally {
    await opened.file.close();
  }
}

async function openImage(path: string): Promise<{ kind: 'open'; file: Awaited<ReturnType<typeof open>> } | { kind: 'missing' } | { kind: 'error' }> {
  try {
    const noFollow = (constants as Record<string, number | undefined>).O_NOFOLLOW ?? 0;
    return { kind: 'open', file: await open(path, constants.O_RDONLY | noFollow) };
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'error' };
  }
}

async function resolveRealPath(path: string): Promise<RealPath> {
  try {
    return { kind: 'real', path: await realpath(path) };
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'error' };
  }
}

function contains(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsoluteRelative(relativePath));
}

function isAbsoluteRelative(relativePath: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(relativePath) || /^[\\/]/u.test(relativePath);
}

export function isImageSignature(header: Buffer): boolean {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (header.length >= 8 && png.every((byte, index) => header[index] === byte)) return true;
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return true;
  if (header.length >= 6 && header.subarray(0, 4).toString('ascii') === 'GIF8') {
    const version = header.subarray(4, 6).toString('ascii');
    return version === '87a' || version === '89a';
  }
  return header.length >= 12 && header.subarray(0, 4).toString('ascii') === 'RIFF'
    && header.subarray(8, 12).toString('ascii') === 'WEBP';
}
