// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { bumpVersion } from './bump-version.js';
const execute = promisify(execFile);

export async function prepareUpdateFixture(repo, evidence) {
  const candidate = join(evidence, 'candidate', 'NotNativeAgent'), baseline = join(evidence, 'baseline');
  await mkdir(candidate, { recursive: true }); await mkdir(baseline, { recursive: true });
  const { stdout } = await execute('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: repo, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  const files = stdout.trim().split(/\r?\n/u); assert.ok(files.length > 100 && files.length < 20000);
  for (const relative of files) {
    assert.ok(!relative.split('/').includes('..'));
    for (const destination of [candidate, baseline]) {
      await mkdir(dirname(join(destination, relative)), { recursive: true });
      await copyFile(join(repo, relative), join(destination, relative));
    }
  }
  const version = (await readFile(join(candidate, 'VERSION'), 'utf8')).trim();
  const [date, sequence] = version.split('-'); assert.ok(Number(sequence) > 1);
  const previous = await bumpVersion(baseline, { date, iteration: Number(sequence) - 1 });
  const archive = join(evidence, 'candidate.tar.gz');
  await execute('tar', ['-czf', archive, '-C', join(evidence, 'candidate'), 'NotNativeAgent'], { windowsHide: true });
  const bytes = await readFile(archive); assert.ok(bytes.length < 64 * 1024 * 1024);
  return { baseline, version, baselineVersion: previous.version, bytes, sha: createHash('sha1').update(bytes).digest('hex') };
}

/** Only the acquisition transport is substituted; CLI, extraction and installation remain real. */
export async function startUpdateFeed(fixture, evidence) {
  const requested = [];
  const server = createServer((request, response) => {
    requested.push(request.url);
    if (request.url === '/commit') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ sha: fixture.sha })); }
    else if (request.url === '/version') response.end(fixture.version);
    else if (request.url === '/archive') { response.setHeader('Content-Length', fixture.bytes.length); response.end(fixture.bytes); }
    else { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const mappings = {
    'https://api.github.com/repos/NotNative/NotNativeAgent/commits/main': `${base}/commit`,
    [`https://api.github.com/repos/NotNative/NotNativeAgent/contents/VERSION?ref=${fixture.sha}`]: `${base}/version`,
    [`https://codeload.github.com/NotNative/NotNativeAgent/tar.gz/${fixture.sha}`]: `${base}/archive`,
  };
  const preload = join(evidence, 'acquisition-transport.mjs');
  await writeFile(preload, `const routes=${JSON.stringify(mappings)}; const original=globalThis.fetch;
globalThis.fetch=(input,init)=>{const destination=routes[String(input)]; if(!destination)throw new Error('Unexpected update acquisition URL');return original(destination,init);};\n`);
  return { preload, requested, close: () => new Promise(resolve => server.close(resolve)) };
}

export async function verifyGithubAcquisition(evidence) {
  const base = 'https://api.github.com/repos/NotNative/NotNativeAgent';
  const options = { headers: { 'User-Agent': 'NNA-installed-update-acceptance' }, signal: AbortSignal.timeout(60000) };
  const commitResponse = await fetch(`${base}/commits/main`, options); assert.ok(commitResponse.ok);
  const { sha } = await commitResponse.json(); assert.match(sha, /^[a-f0-9]{40}$/u);
  const versionResponse = await fetch(`${base}/contents/VERSION?ref=${sha}`, { ...options, headers: { ...options.headers, Accept: 'application/vnd.github.raw+json' } });
  assert.ok(versionResponse.ok); const version = (await versionResponse.text()).trim(); assert.match(version, /^\d{8}-[1-9]\d*$/u);
  const response = await fetch(`https://codeload.github.com/NotNative/NotNativeAgent/tar.gz/${sha}`, options); assert.ok(response.ok);
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; assert.ok(size < 64 * 1024 * 1024); chunks.push(chunk); }
  const archive = join(evidence, 'github-main.tar.gz'); await writeFile(archive, Buffer.concat(chunks));
  const { stdout } = await execute('tar', ['-tzf', archive], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  const entries = stdout.split(/\r?\n/u);
  assert.ok(entries.some(name => name.endsWith('/desktop/install.cmd')));
  const versionEntry = entries.find(name => name.endsWith('/VERSION') && name.split('/').length === 2);
  assert.ok(versionEntry);
  const embedded = await execute('tar', ['-xOf', archive, versionEntry], { windowsHide: true });
  assert.equal(embedded.stdout.trim(), version);
  return { version, sha, archive_bytes: size, desktop_present: true };
}
