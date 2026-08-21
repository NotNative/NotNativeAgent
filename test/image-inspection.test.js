// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PathPolicy } from '../src/path-policy.js';
import { imageInspectDefinition } from '../src/tools/image-inspection.js';

async function fixture(observer) {
  const root = await mkdtemp(join(tmpdir(), 'nna-image-inspect-'));
  const image = join(root, 'capture.png');
  await writeFile(image, Buffer.from('89504e470d0a1a0a', 'hex'));
  const paths = new PathPolicy(root, { boundedToWorkspace: true });
  await paths.initialize();
  return { root, image, definition: imageInspectDefinition(paths, observer, { maxBytes: 1024 }) };
}

test('image.inspect gives visual inference its own tool lifecycle', async () => {
  const observed = [];
  const { image, definition } = await fixture(async (path, mimeType, prompt) => {
    observed.push({ path, mimeType, prompt });
    return { route: 'vision', text: 'A blue ocean and lighthouse are visible.' };
  });
  const validated = await definition.validate({ path: image, prompt: 'Check the rendered scene.' });
  const result = await definition.executor(validated, new AbortController().signal);
  assert.deepEqual(observed, [{ path: image, mimeType: 'image/png', prompt: 'Check the rendered scene.' }]);
  assert.match(result.content, /Visual observation \(vision route\)[^]*blue ocean/iu);
  assert.equal(result.metadata.visualRoute, 'vision');
});

test('image.inspect reports inference failure without changing screenshot capture', async () => {
  const { image, definition } = await fixture(async () => {
    throw Object.assign(new Error('vision unavailable'), { code: 'provider_idle_timeout' });
  });
  const validated = await definition.validate({ path: image });
  await assert.rejects(definition.executor(validated, new AbortController().signal), { code: 'provider_idle_timeout' });
});

test('image.inspect validates type and configured byte bound before inference', async () => {
  const { root, definition } = await fixture(async () => ({ route: 'primary', text: 'unused' }));
  const text = join(root, 'not-an-image.txt');
  await writeFile(text, 'plain text');
  await assert.rejects(definition.validate({ path: text }), { code: 'attachment_type_unsupported' });
  const large = join(root, 'large.png');
  await writeFile(large, Buffer.alloc(2048));
  await assert.rejects(definition.validate({ path: large }), { code: 'attachment_size_invalid' });
});
