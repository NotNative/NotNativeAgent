// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readDesktopSshConfigTree } from './ssh-config-reader.mjs';

async function withHome(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nnd-ssh-config-'));
  try { return await run(root); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('expands bounded recursive Include globs, preserves host blocks, and skips cycles/outside paths', async () => {
  await withHome(async (home) => {
    const ssh = path.join(home, '.ssh');
    const nested = path.join(ssh, 'conf.d', 'more');
    const outsideName = `${path.basename(home)}-outside.conf`;
    const outsidePath = path.join(path.dirname(home), outsideName);
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(outsidePath, 'Host outside-secret\n');
    fs.writeFileSync(path.join(ssh, 'config'), [
      'Host main', '  User dev', 'Include conf.d/*.conf', `Include ../../${outsideName}`,
    ].join('\n'));
    fs.writeFileSync(path.join(ssh, 'conf.d', 'hosts.conf'), 'Host included\nInclude more/*.conf');
    fs.writeFileSync(path.join(nested, 'extra.conf'), 'Host deep\nInclude ../../config');
    try {
      const result = await readDesktopSshConfigTree({ homeDir: home });
      assert.match(result, /Host main/u);
      assert.match(result, /Host included/u);
      assert.match(result, /Host deep/u);
      assert.doesNotMatch(result, /outside-secret/u);
      assert.equal((result.match(/Host main/gu) ?? []).length, 1);
    } finally { fs.rmSync(outsidePath, { force: true }); }
  });
});

test('missing root configs and over-budget files return an empty safe result', async () => {
  await withHome(async (home) => {
    assert.equal(await readDesktopSshConfigTree({ homeDir: home }), '');
    const ssh = path.join(home, '.ssh');
    fs.mkdirSync(ssh, { recursive: true });
    fs.writeFileSync(path.join(ssh, 'config'), 'Host too-large\n'.padEnd(1_048_577, 'x'));
    assert.equal(await readDesktopSshConfigTree({ homeDir: home }), '');
  });
});

test('rejects a descriptor that no longer identifies the checked in-home path', async () => {
  await withHome(async (home) => {
    const ssh = path.join(home, '.ssh');
    const config = path.join(ssh, 'config');
    const outside = path.join(path.dirname(home), `${path.basename(home)}-raced.conf`);
    fs.mkdirSync(ssh, { recursive: true });
    fs.writeFileSync(config, 'Host safe\n');
    fs.writeFileSync(outside, 'Host outside-secret\n');
    const racingFileSystem = new Proxy(fs, {
      get(target, property) {
        if (property === 'openSync') return (file, flags) => fs.openSync(file === config ? outside : file, flags);
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    try {
      const result = await readDesktopSshConfigTree({ homeDir: home, fileSystem: racingFileSystem });
      assert.doesNotMatch(result, /outside-secret/u);
    } finally { fs.rmSync(outside, { force: true }); }
  });
});

test('compares large Windows-style file ids without losing integer precision', async () => {
  await withHome(async (home) => {
    const ssh = path.join(home, '.ssh');
    fs.mkdirSync(ssh, { recursive: true });
    fs.writeFileSync(path.join(ssh, 'config'), 'Host large-id\n');
    const inode = 9_007_199_254_741_117n;
    const fileSystem = new Proxy(fs, {
      get(target, property) {
        if (property === 'fstatSync' || property === 'statSync') {
          const method = Reflect.get(target, property, target);
          return (...args) => {
            const stats = method.apply(target, args);
            return new Proxy(stats, {
              get(value, key) {
                if (key === 'ino') return inode;
                const member = Reflect.get(value, key, value);
                return typeof member === 'function' ? member.bind(value) : member;
              },
            });
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    assert.match(await readDesktopSshConfigTree({ homeDir: home, fileSystem }), /Host large-id/u);
  });
});
