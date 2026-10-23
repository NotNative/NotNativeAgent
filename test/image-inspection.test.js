// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PathPolicy } from '../src/path-policy.js';
import { imageInspectDefinition, visualVerdict } from '../src/tools/image-inspection.js';
import { resolveManifest } from '../src/config.js';
import { SessionEngine } from '../src/engine.js';

async function fixture(observer) {
  const root = await mkdtemp(join(tmpdir(), 'nna-image-inspect-'));
  const image = join(root, 'capture.png');
  await writeFile(image, Buffer.from('89504e470d0a1a0a', 'hex'));
  const paths = new PathPolicy(root, { boundedToWorkspace: true });
  await paths.initialize();
  return { root, image, definition: imageInspectDefinition(paths, observer, { maxBytes: 1024 }) };
}

test('image_inspect gives visual inference its own tool lifecycle', async () => {
  const observed = [];
  const { image, definition } = await fixture(async (path, mimeType, prompt) => {
    observed.push({ path, mimeType, prompt });
    return { route: 'vision', text: 'A blue ocean and lighthouse are visible.\nVISUAL_VERDICT: pass' };
  });
  const validated = await definition.validate({ path: image, prompt: 'Check the rendered scene.' });
  const result = await definition.executor(validated, new AbortController().signal);
  assert.equal(observed[0].path, image);
  assert.equal(observed[0].mimeType, 'image/png');
  assert.match(observed[0].prompt, /^Check the rendered scene\.[^]*VISUAL_VERDICT: pass/iu);
  assert.match(observed[0].prompt, /requested major scene element[^]*material_issue/iu);
  assert.match(result.content, /Visual observation \(vision route\)[^]*blue ocean/iu);
  assert.equal(result.metadata.visualRoute, 'vision');
  assert.equal(result.metadata.visualVerdict, 'pass');
});

test('image_inspect normalizes a bounded verdict and defaults missing rubrics to uncertain', () => {
  assert.equal(visualVerdict('Visible seam.\nVISUAL_VERDICT: material_issue'), 'material_issue');
  assert.equal(visualVerdict('No rubric returned.'), 'uncertain');
  assert.equal(visualVerdict('VISUAL_VERDICT: invented'), 'uncertain');
});

test('image_inspect reports inference failure without changing screenshot capture', async () => {
  const { image, definition } = await fixture(async () => {
    throw Object.assign(new Error('vision unavailable'), { code: 'provider_idle_timeout' });
  });
  const validated = await definition.validate({ path: image });
  await assert.rejects(definition.executor(validated, new AbortController().signal), { code: 'provider_idle_timeout' });
});

test('image_inspect validates type and configured byte bound before inference', async () => {
  const { root, definition } = await fixture(async () => ({ route: 'primary', text: 'unused' }));
  const text = join(root, 'not-an-image.txt');
  await writeFile(text, 'plain text');
  await assert.rejects(definition.validate({ path: text }), { code: 'attachment_type_unsupported' });
  const large = join(root, 'large.png');
  await writeFile(large, Buffer.alloc(2048));
  await assert.rejects(definition.validate({ path: large }), { code: 'attachment_size_invalid' });
});

test('image_inspect follows live attachment byte-limit updates', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'nna-image-limit-update-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const image = join(root, 'updated.png');
  await writeFile(image, Buffer.alloc(1536));
  const raw = {
    persistence: 'ephemeral', workspace_root: root,
    provider: { id: 'fixture', endpoint: 'http://127.0.0.1:9999/v1', model: 'fixture-model', trust_zone: 'loopback' },
  };
  const engine = new SessionEngine({
    config: resolveManifest({ ...raw, attachments: { max_bytes: 1024 } }),
    providerFactory: () => ({ async *stream() {} }), output: async () => undefined,
  });
  await engine.initialize();
  const imageInspect = engine.tools.definition('image_inspect');
  await assert.rejects(imageInspect.validate({ path: image }), { code: 'attachment_size_invalid' });

  await engine.updateConfiguration({ request_id: 'increase', manifest: {
    ...raw, attachments: { max_bytes: 2048 },
  } }, 'authenticated-local-operator');
  await imageInspect.validate({ path: image });

  await engine.updateConfiguration({ request_id: 'decrease', manifest: {
    ...raw, attachments: { max_bytes: 1024 },
  } }, 'authenticated-local-operator');
  await assert.rejects(imageInspect.validate({ path: image }), { code: 'attachment_size_invalid' });
});
