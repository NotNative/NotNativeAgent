// SPDX-License-Identifier: Apache-2.0
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { removeFileWithRetry, replaceFileWithRetry } from './windows-file-replace.mjs';

const MAX_READ_BYTES = 50 * 1024 * 1024;
const MAX_MARKDOWN_BYTES = 50 * 1024 * 1024;
const MIME_BY_EXTENSION = new Map([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.gif', 'image/gif'],
  ['.webp', 'image/webp'], ['.svg', 'image/svg+xml'], ['.bmp', 'image/bmp'], ['.ico', 'image/x-icon'],
  ['.pdf', 'application/pdf'], ['.txt', 'text/plain; charset=utf-8'], ['.md', 'text/markdown; charset=utf-8'],
  ['.json', 'application/json'], ['.js', 'text/javascript; charset=utf-8'],
  ['.ts', 'text/typescript; charset=utf-8'], ['.tsx', 'text/typescript; charset=utf-8'],
  ['.jsx', 'text/javascript; charset=utf-8'], ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'], ['.py', 'text/x-python; charset=utf-8'],
]);
const DENIED_HOME_PATHS = [
  '.ssh', '.aws', '.gnupg', '.gpg', '.config/gh', '.config/openchamber/credentials',
  '.azure', '.docker', '.kube', '.config/gcloud',
];
const DENIED_HOME_FILENAMES = new Set([
  '.npmrc', '.netrc', '.git-credentials', '.gitconfig', '.pypirc', '.pgpass', '.my.cnf',
]);

function within(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function normalizedRelative(root, target) {
  return path.relative(root, target).split(path.sep).join('/').toLowerCase();
}

function isDeniedHomeRelative(relative) {
  return DENIED_HOME_PATHS.some((denied) => relative === denied || relative.startsWith(`${denied}/`));
}

function isCredentialFilename(filePath) {
  const name = path.basename(filePath).toLowerCase();
  return DENIED_HOME_FILENAMES.has(name) || name === '.env' || name.startsWith('.env.')
    || name.endsWith('.pem') || name.endsWith('.key');
}

function assertReadPathAllowed(resolvedPath, realPath, homeRoot, tempRoot) {
  const allowedHome = within(homeRoot, resolvedPath) && within(homeRoot, realPath);
  const allowedTemp = within(tempRoot, resolvedPath) && within(tempRoot, realPath);
  if (!allowedHome && !allowedTemp) throw new Error('File is outside the allowed workspace');
  if (allowedHome && (isDeniedHomeRelative(normalizedRelative(homeRoot, resolvedPath))
    || isDeniedHomeRelative(normalizedRelative(homeRoot, realPath)))) {
    throw new Error('Access to this path is not allowed');
  }
  if (isCredentialFilename(resolvedPath) || isCredentialFilename(realPath)) {
    throw new Error('Access to this path is not allowed');
  }
}

function defaultMarkdownName(value) {
  if (typeof value !== 'string' || value.trim() === '') return 'notes.md';
  return value.trim().replace(/[\\/]/gu, '_').slice(0, 240) || 'notes.md';
}

export function createFileUtilities({ homeDir, tempDir, dialog, getWindow = () => undefined,
  fileSystem = fs, platform = process.platform, replaceFile = replaceFileWithRetry } = {}) {
  if (typeof homeDir !== 'string' || typeof tempDir !== 'string') throw new TypeError('homeDir and tempDir are required');
  const homePath = path.resolve(homeDir);
  const tempPath = path.resolve(tempDir);

  return {
    async readFile(rawPath) {
      if (typeof rawPath !== 'string' || rawPath.trim() === '' || rawPath.length > 32_768) {
        throw new Error('Path is required');
      }
      const resolvedPath = path.resolve(rawPath);
      let realPath;
      try { realPath = await fileSystem.realpath(resolvedPath); }
      catch (error) { throw new Error(`File could not be read: ${error instanceof Error ? error.message : String(error)}`); }
      const [homeRoot, tempRoot] = await Promise.all([
        fileSystem.realpath(homePath), fileSystem.realpath(tempPath),
      ]);
      assertReadPathAllowed(resolvedPath, realPath, homeRoot, tempRoot);
      let file;
      try { file = await fileSystem.open(realPath, 'r'); }
      catch (error) { throw new Error(`File could not be read: ${error instanceof Error ? error.message : String(error)}`); }
      let contents;
      try {
        const info = await file.stat();
        if (!info.isFile()) throw new Error('Path is not a file');
        if (info.size > MAX_READ_BYTES) throw new Error('File is too large. Maximum size is 50MB.');
        const chunks = [];
        let size = 0;
        for await (const chunk of file.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 })) {
          size += chunk.byteLength;
          if (size > MAX_READ_BYTES) throw new Error('File is too large. Maximum size is 50MB.');
          chunks.push(chunk);
        }
        contents = Buffer.concat(chunks, size);
      } catch (error) {
        throw error instanceof Error && (error.message === 'Path is not a file'
          || error.message === 'File is too large. Maximum size is 50MB.')
          ? error : new Error(`File could not be read: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        await file.close().catch(() => {});
      }
      return {
        mime: MIME_BY_EXTENSION.get(path.extname(realPath).toLowerCase()) ?? 'application/octet-stream',
        base64: contents.toString('base64'),
        size: contents.byteLength,
      };
    },

    async saveMarkdown(defaultFileName, content) {
      if (typeof content !== 'string') throw new Error('Markdown content is required');
      if (Buffer.byteLength(content, 'utf8') > MAX_MARKDOWN_BYTES) throw new Error('Markdown file is too large. Maximum size is 50MB.');
      if (!dialog || typeof dialog.showSaveDialog !== 'function') throw new Error('Save dialog is unavailable');
      const result = await dialog.showSaveDialog(getWindow(), {
        defaultPath: defaultMarkdownName(defaultFileName),
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      });
      if (result.canceled || typeof result.filePath !== 'string' || result.filePath === '') return null;
      const temporaryPath = path.join(path.dirname(result.filePath), `.notnative-${randomUUID()}.tmp`);
      try {
        await fileSystem.writeFile(temporaryPath, content, {
          encoding: 'utf8', flag: 'wx', mode: platform === 'win32' ? undefined : 0o600,
        });
        await replaceFile(temporaryPath, result.filePath, {
          platform, rename: (from, to) => fileSystem.rename(from, to),
        });
      } catch (error) {
        await removeFileWithRetry(temporaryPath, {
          platform,
          remove: (filePath) => fileSystem.rm(filePath, { force: true }),
        }).catch(() => {});
        throw error;
      }
      return path.resolve(result.filePath);
    },
  };
}

export const FILE_UTILITY_LIMITS = Object.freeze({ maxReadBytes: MAX_READ_BYTES, maxMarkdownBytes: MAX_MARKDOWN_BYTES });
