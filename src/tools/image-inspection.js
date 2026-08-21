// SPDX-License-Identifier: Apache-2.0
import { extname } from 'node:path';
import { ContractError } from '../ids.js';

const MIME_TYPES = Object.freeze({
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp',
});
const DEFAULT_PROMPT = 'Visually inspect this image. Describe the rendered scene, layout, visible defects, missing content, and evidence relevant to verifying the active task.';

export function imageInspectDefinition(paths, observeImage, options = {}) {
  return {
    name: 'image.inspect', version: 1,
    purpose: 'Visually interpret an existing bounded PNG, JPEG, GIF, or WebP image in a separate provider step. Use the exact path returned by web.browse screenshot to analyze a captured page. Image inference has its own lifecycle and cannot change a successful screenshot capture into a browser failure.',
    sideEffect: 'read_only', scope: 'workspace', cancellation: true, timeoutMs: 600_000,
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['path'], properties: {
        path: { type: 'string', maxLength: 4096, description: 'Existing image path, including the exact path returned by web.browse screenshot.' },
        prompt: { type: 'string', maxLength: 4096, description: 'Optional focused visual inspection request.' },
      },
    },
    validate: async (args) => validate(args, paths, options.maxBytes ?? 10_485_760),
    executor: async (request, signal) => {
      if (!observeImage) throw new ContractError('image_observer_unavailable', 'no managed image observer is configured');
      const observation = await observeImage(request.resolved.path, request.resolved.mimeType,
        request.args.prompt ?? DEFAULT_PROMPT, signal);
      const text = String(observation?.text ?? '').trim();
      if (!text) throw new ContractError('attachment_empty_observation', 'image observer returned no visual description');
      const route = observation?.route === 'vision' ? 'vision' : 'primary';
      return {
        content: `Visual observation (${route} route):\n${text.slice(0, 131_072)}`,
        metadata: { path: request.resolved.path, mimeType: request.resolved.mimeType, visualRoute: route },
      };
    },
  };
}

async function validate(args, paths, maxBytes) {
  if (!args || typeof args !== 'object' || Array.isArray(args)
    || typeof args.path !== 'string' || args.path.length === 0 || args.path.length > 4096
    || (args.prompt !== undefined && (typeof args.prompt !== 'string' || args.prompt.length > 4096))
    || Object.keys(args).some((key) => !['path', 'prompt'].includes(key))) {
    throw new ContractError('tool_schema_invalid', 'image.inspect requires a bounded image path and optional prompt');
  }
  const resolved = await paths.resolveRead(args.path);
  if (resolved.size > maxBytes) throw new ContractError('attachment_size_invalid', 'image exceeds the configured attachment byte limit');
  const mimeType = MIME_TYPES[extname(resolved.path).toLowerCase()];
  if (!mimeType) throw new ContractError('attachment_type_unsupported', 'image.inspect supports PNG, JPEG, GIF, and WebP files');
  return {
    args: { path: args.path, ...(args.prompt === undefined ? {} : { prompt: args.prompt }) },
    resolved: { ...resolved, mimeType },
  };
}
