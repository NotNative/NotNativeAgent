// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createFileUtilities, FILE_UTILITY_LIMITS } from './file-utilities.mjs';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nnd-file-utilities-'));
  const homeDir = path.join(root, 'home');
  const tempDir = path.join(root, 'tmp');
  await Promise.all([mkdir(homeDir), mkdir(tempDir)]);
  return { root, homeDir, tempDir };
}

test('readFile returns a base64 payload and MIME type for allowed home and temp files', async (t) => {
  const dirs = await fixture();
  t.after(() => rm(dirs.root, { recursive: true, force: true }));
  const homeFile = path.join(dirs.homeDir, 'notes.md');
  const tempFile = path.join(dirs.tempDir, 'image.PNG');
  await Promise.all([writeFile(homeFile, 'hello'), writeFile(tempFile, Buffer.from([1, 2, 3]))]);
  const files = createFileUtilities({ ...dirs });
  assert.deepEqual(await files.readFile(homeFile), {
    mime: 'text/markdown; charset=utf-8', base64: Buffer.from('hello').toString('base64'), size: 5,
  });
  assert.deepEqual(await files.readFile(tempFile), {
    mime: 'image/png', base64: Buffer.from([1, 2, 3]).toString('base64'), size: 3,
  });
});

test('readFile blocks paths outside roots, credential directories, and credential file names', async (t) => {
  const dirs = await fixture();
  t.after(() => rm(dirs.root, { recursive: true, force: true }));
  const outside = path.join(dirs.root, 'outside.txt');
  await writeFile(outside, 'secret');
  const denied = [
    path.join(dirs.homeDir, '.ssh', 'id_ed25519'),
    path.join(dirs.homeDir, '.aws', 'credentials'),
    path.join(dirs.homeDir, '.gnupg', 'key'),
    path.join(dirs.homeDir, '.gpg', 'key'),
    path.join(dirs.homeDir, '.config', 'gh', 'hosts.yml'),
    path.join(dirs.homeDir, '.config', 'openchamber', 'credentials', 'auth.json'),
    path.join(dirs.homeDir, '.npmrc'), path.join(dirs.homeDir, '.netrc'),
    path.join(dirs.homeDir, '.git-credentials'), path.join(dirs.homeDir, '.pypirc'),
    path.join(dirs.homeDir, '.azure', 'accessTokens.json'),
    path.join(dirs.homeDir, '.docker', 'config.json'),
    path.join(dirs.homeDir, '.kube', 'config'),
    path.join(dirs.homeDir, '.config', 'gcloud', 'credentials.db'),
    path.join(dirs.homeDir, '.env'), path.join(dirs.homeDir, '.env.local'),
    path.join(dirs.homeDir, 'server.pem'), path.join(dirs.homeDir, 'private.key'),
  ];
  for (const filePath of denied) {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, 'secret');
  }
  const files = createFileUtilities({ ...dirs });
  await assert.rejects(files.readFile(outside), /outside the allowed workspace/u);
  for (const filePath of denied) await assert.rejects(files.readFile(filePath), /not allowed/u, filePath);
});

test('readFile rejects a symlink-resolved target that escapes an allowed root', async (t) => {
  const dirs = await fixture();
  t.after(() => rm(dirs.root, { recursive: true, force: true }));
  const outside = path.join(dirs.root, 'outside.txt');
  const link = path.join(dirs.homeDir, 'safe-name.txt');
  await writeFile(outside, 'secret');
  const fakeFs = {
    realpath: async (value) => path.resolve(value) === link ? outside : path.resolve(value),
    open: async (value, flags) => (await import('node:fs/promises')).open(value, flags),
  };
  const files = createFileUtilities({ ...dirs, fileSystem: fakeFs });
  await assert.rejects(files.readFile(link), /outside the allowed workspace/u);
});

test('readFile rejects directories and enforces the size ceiling before loading bytes', async (t) => {
  const dirs = await fixture();
  t.after(() => rm(dirs.root, { recursive: true, force: true }));
  const folder = path.join(dirs.homeDir, 'folder');
  await mkdir(folder);
  const files = createFileUtilities({ ...dirs });
  await assert.rejects(files.readFile(folder), /not a file/u);
  const filePath = path.join(dirs.homeDir, 'large.txt');
  const fakeFs = {
    realpath: async (value) => path.resolve(value),
    open: async (value) => value === filePath ? ({
      stat: async () => ({ isFile: () => true, size: FILE_UTILITY_LIMITS.maxReadBytes + 1 }),
      createReadStream: () => { throw new Error('oversized contents were loaded'); },
      close: async () => {},
    }) : (await import('node:fs/promises')).open(value, 'r'),
  };
  const guarded = createFileUtilities({ ...dirs, fileSystem: fakeFs });
  await assert.rejects(guarded.readFile(filePath), /Maximum size is 50MB/u);
});

test('saveMarkdown waits for the native picker, uses a leaf default name, and writes only after selection', async (t) => {
  const dirs = await fixture();
  t.after(() => rm(dirs.root, { recursive: true, force: true }));
  let options;
  const destination = path.join(dirs.tempDir, 'chosen.md');
  const files = createFileUtilities({ ...dirs, dialog: { showSaveDialog: async (_window, value) => {
    options = value;
    return { canceled: false, filePath: destination };
  } } });
  const saved = await files.saveMarkdown('../unsafe/name.md', '# Notes');
  assert.equal(saved, destination);
  assert.equal(await readFile(destination, 'utf8'), '# Notes');
  assert.equal(options.defaultPath, '.._unsafe_name.md');
  assert.deepEqual(options.filters, [{ name: 'Markdown', extensions: ['md'] }]);

  const cancelled = createFileUtilities({ ...dirs, dialog: { showSaveDialog: async () => ({ canceled: true }) } });
  assert.equal(await cancelled.saveMarkdown('cancelled.md', 'discard'), null);
  await assert.rejects(readFile(path.join(dirs.tempDir, 'cancelled.md')), { code: 'ENOENT' });
});

test('saveMarkdown preserves the old target and cleans its temporary file after replacement failure', async (t) => {
  const dirs = await fixture();
  t.after(() => rm(dirs.root, { recursive: true, force: true }));
  const destination = path.join(dirs.tempDir, 'existing.md');
  await writeFile(destination, 'old');
  const fileSystem = {
    writeFile, rm,
    rename: async () => { const error = new Error('target is locked'); error.code = 'EBUSY'; throw error; },
  };
  const files = createFileUtilities({ ...dirs, fileSystem, platform: 'linux',
    dialog: { showSaveDialog: async () => ({ canceled: false, filePath: destination }) } });
  await assert.rejects(files.saveMarkdown('existing.md', 'new'), /target is locked/u);
  assert.equal(await readFile(destination, 'utf8'), 'old');
  assert.deepEqual(await readdir(dirs.tempDir), ['existing.md']);
});

test('saveMarkdown replaces an existing file atomically on the host filesystem', async (t) => {
  const dirs = await fixture();
  t.after(() => rm(dirs.root, { recursive: true, force: true }));
  const destination = path.join(dirs.tempDir, 'existing.md');
  await writeFile(destination, 'old');
  const files = createFileUtilities({ ...dirs,
    dialog: { showSaveDialog: async () => ({ canceled: false, filePath: destination }) } });
  assert.equal(await files.saveMarkdown('existing.md', 'new'), destination);
  assert.equal(await readFile(destination, 'utf8'), 'new');
  assert.deepEqual(await readdir(dirs.tempDir), ['existing.md']);
});

test('saveMarkdown retries temporary cleanup after a transient Windows lock', async (t) => {
  const dirs = await fixture();
  t.after(() => rm(dirs.root, { recursive: true, force: true }));
  let cleanupAttempts = 0;
  const fileSystem = {
    writeFile,
    rm: async (...args) => {
      cleanupAttempts += 1;
      if (cleanupAttempts === 1) { const error = new Error('scanner lock'); error.code = 'EBUSY'; throw error; }
      return rm(...args);
    },
  };
  const destination = path.join(dirs.tempDir, 'failed.md');
  const files = createFileUtilities({ ...dirs, fileSystem, platform: 'win32',
    replaceFile: async () => { throw new Error('replacement failed'); },
    dialog: { showSaveDialog: async () => ({ canceled: false, filePath: destination }) } });
  await assert.rejects(files.saveMarkdown('failed.md', 'new'), /replacement failed/u);
  assert.equal(cleanupAttempts, 2);
  assert.deepEqual(await readdir(dirs.tempDir), []);
});
