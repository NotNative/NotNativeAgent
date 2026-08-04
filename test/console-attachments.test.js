// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveManifest } from '../src/config.js';
import { InteractiveWorkspace } from '../src/interactive-workspace.js';
import {
  detachConsoleAttachment, queueClipboardImage, queueConsoleAttachment, queuePastedImagePaths,
} from '../src/workspace-attachments.js';

function configuration(root) {
  return resolveManifest({
    persistence: 'ephemeral', workspace_root: root,
    provider: {
      id: 'vision-local', endpoint: 'http://127.0.0.1:9/v1', model: 'vision-model', trust_zone: 'loopback',
      capabilities: { images: true, tools: true },
    },
    attachments: { enabled: true, max_bytes: 1024, retain: false },
  });
}

test('Console queues tab-local images and submits them through managed admission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-console-attachment-'));
  const image = join(root, 'sample.png');
  await writeFile(image, Buffer.from('89504e470d0a1a0a', 'hex'));
  const providerFactory = () => ({ async *stream(request) {
    if (Array.isArray(request.messages[0]?.content)) yield { type: 'text', text: 'A small test image.' };
    else yield { type: 'text', text: 'I used the admitted image observation.' };
    yield { type: 'terminal' };
  } });
  const workspace = new InteractiveWorkspace({ config: configuration(root), providerFactory, attachmentRoot: join(root, 'attachments') });
  await workspace.create('Main', 'main');
  const queued = await queueConsoleAttachment(workspace, 'sample.png');
  assert.equal(queued.mime_type, 'image/png');
  assert.equal(workspace.projection.active().pendingAttachments.length, 1);
  await workspace.submitActive('Describe the attached image.');
  assert.equal(workspace.projection.active().pendingAttachments.length, 0);
  assert.ok(workspace.projection.active().records.some((item) => item.type === 'attachment_status' && item.state === 'admitted'),
    JSON.stringify(workspace.projection.active().records));
  await workspace.shutdown();
});

test('queued attachment removal is indexed, bounded, and conversation-local', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-console-detach-'));
  const image = join(root, 'sample.png');
  await writeFile(image, Buffer.from('89504e470d0a1a0a', 'hex'));
  const workspace = new InteractiveWorkspace({
    config: configuration(root), providerFactory: () => ({ async *stream() { yield { type: 'terminal' }; } }),
  });
  await workspace.create('Main', 'main');
  await queueConsoleAttachment(workspace, image);
  assert.equal(detachConsoleAttachment(workspace, '1'), 1);
  assert.throws(() => detachConsoleAttachment(workspace, '1'), { code: 'attachment_selection_invalid' });
  await workspace.shutdown();
});

test('clipboard images persist under the session attachment store and dropped image paths queue directly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-console-ingress-'));
  const dropped = join(root, 'dropped image.png');
  await writeFile(dropped, Buffer.from('89504e470d0a1a0a', 'hex'));
  const workspace = new InteractiveWorkspace({
    config: configuration(root), attachmentRoot: join(root, 'attachments', 'main'),
    providerFactory: () => ({ async *stream() { yield { type: 'terminal' }; } }),
    clipboardImageRead: async (path) => writeFile(path, Buffer.from('89504e470d0a1a0a', 'hex')),
  });
  await workspace.create('Main', 'main');
  const clipboard = await queueClipboardImage(workspace);
  assert.match(clipboard.path, /attachments[\\/]main[\\/]clipboard-ingress[\\/]clipboard-/u);
  assert.equal((await queuePastedImagePaths(workspace, `"${dropped}" "${dropped}"`)).length, 2);
  assert.equal(workspace.projection.active().pendingAttachments.length, 3);
  await workspace.shutdown();
});
