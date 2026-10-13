// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createLocalPathUtilities, unsupportedAppSpecificOpenError, validateLocalPath } from './local-paths.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nnd-local-paths-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'notes.md');
  const dir = path.join(root, 'folder');
  await Promise.all([writeFile(file, 'notes'), mkdir(dir)]);
  return { root, file, dir };
}

test('validateLocalPath normalizes and checks readable files and traversable directories', async (t) => {
  const paths = await fixture(t);
  assert.equal((await validateLocalPath(`  ${paths.file}  `)).path, paths.file);
  assert.equal((await validateLocalPath(paths.dir)).stats.isDirectory(), true);
  await assert.rejects(validateLocalPath('  '), /Path is required/u);
  await assert.rejects(validateLocalPath(path.join(paths.root, 'gone')), /Path does not exist:/u);
});

test('validateLocalPath rejects special files and reports access failures clearly', async (t) => {
  const paths = await fixture(t);
  const specialPath = path.join(paths.root, 'pipe');
  const specialFs = {
    stat: async () => ({ isDirectory: () => false, isFile: () => false }),
    access: async () => {},
  };
  await assert.rejects(validateLocalPath(specialPath, 'Path', { fileSystem: specialFs }), /not a regular file or directory/u);
  const deniedFs = {
    stat: async () => ({ isDirectory: () => false, isFile: () => true }),
    access: async () => { const error = new Error('denied'); error.code = 'EACCES'; throw error; },
  };
  await assert.rejects(validateLocalPath(paths.file, 'File', { fileSystem: deniedFs }), /File is not accessible:/u);
  const failedFs = {
    stat: async () => { throw new Error('I/O error'); },
    access: async () => {},
  };
  await assert.rejects(validateLocalPath(paths.file, 'File', { fileSystem: failedFs }), /File could not be checked: I\/O error/u);
});

test('open and reveal expose resolved shell errors and reveal according to file type', async (t) => {
  const paths = await fixture(t);
  const opened = [];
  const revealed = [];
  const utilities = createLocalPathUtilities({ shell: {
    openPath: async (value) => { opened.push(value); return ''; },
    showItemInFolder: (value) => revealed.push(value),
  } });
  assert.equal(await utilities.open(paths.file), null);
  assert.deepEqual(opened, [paths.file]);
  assert.equal(await utilities.reveal(paths.file), null);
  assert.deepEqual(revealed, [paths.file]);
  assert.equal(await utilities.reveal(paths.dir), null);
  assert.deepEqual(opened, [paths.file, paths.dir]);

  const failing = createLocalPathUtilities({ shell: {
    openPath: async () => 'No application is associated with this file',
    showItemInFolder: () => {},
  } });
  await assert.rejects(failing.open(paths.file), /No application is associated/u);
  await assert.rejects(failing.reveal(paths.dir), /No application is associated/u);
});

test('app-specific open is macOS-only and passes arguments without shell interpolation', async (t) => {
  const paths = await fixture(t);
  assert.match(unsupportedAppSpecificOpenError('file', 'win32'), /Windows/u);
  const windows = createLocalPathUtilities({ platform: 'win32', shell: { openPath: async () => '', showItemInFolder: () => {} } });
  await assert.rejects(windows.open(paths.file, 'Editor'), /not supported on Windows/u);
  const invoked = [];
  const mac = createLocalPathUtilities({ platform: 'darwin', openWithApp: async (...args) => invoked.push(args),
    shell: { openPath: async () => '', showItemInFolder: () => {} } });
  await assert.rejects(mac.open(paths.file, '-n'), /App name is invalid/u);
  await mac.open(paths.file, 'Visual Editor');
  assert.deepEqual(invoked[0], ['open', ['-a', 'Visual Editor', '--', paths.file], { windowsHide: true }]);
});
