// SPDX-License-Identifier: Apache-2.0

const OPTIONAL_REJECTION_STATUSES = new Set([400, 404, 415, 422, 501]);
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XxYNkwAAAABJRU5ErkJggg==';

export async function qualifyProviderRequests(profile, probe) {
  const chat = await probe(chatRequest(profile), 'Test provider chat requests');
  if (!chat.accepted) throw chat.error;
  const vision = await probe(visionRequest(profile), 'Test provider image requests');
  if (!vision.accepted && !isOptionalRejection(vision)) throw vision.error;
  const single = await probe(toolCallProbeRequest(profile, false), 'Test provider single tool-call requests');
  if (!single.accepted && !isOptionalRejection(single)) throw single.error;
  const batch = await probe(toolCallProbeRequest(profile), 'Test provider batch tool-call requests');
  if (!batch.accepted && !isOptionalRejection(batch)) throw batch.error;
  const tools = single.accepted || batch.accepted;
  return Object.freeze({
    chat: true, images: vision.accepted, tools,
    singleToolCalls: single.accepted, batchToolCalls: batch.accepted,
    toolCallMode: single.accepted ? 'single' : batch.accepted ? 'batch' : 'single',
  });
}

export async function probeToolCallMode(profile, probe) {
  const single = await probe(toolCallProbeRequest(profile, false), 'Test provider single tool-call requests');
  if (single.accepted) return Object.freeze({ supportedMode: 'single' });
  if (single.status !== 400) throw single.error;
  const batch = await probe(toolCallProbeRequest(profile), 'Test provider batch tool-call requests');
  if (!batch.accepted) throw batch.error;
  return Object.freeze({ supportedMode: 'batch' });
}

function chatRequest(profile) {
  return {
    model: profile.model, maxOutputTokens: 1,
    messages: [{ role: 'user', content: 'Return one brief response.' }],
  };
}

function visionRequest(profile) {
  return {
    model: profile.model, maxOutputTokens: 1,
    messages: [{ role: 'user', content: [
      { type: 'text', text: 'Return one brief response.' },
      { type: 'image_url', image_url: { url: PIXEL } },
    ] }],
  };
}

function toolCallProbeRequest(profile, parallelToolCalls) {
  return {
    model: profile.model,
    messages: [
      { role: 'system', content: 'Test tool-call request compatibility.' },
      { role: 'user', content: 'Return one brief response.' },
    ],
    tools: [{ type: 'function', function: {
      name: 'nna_provider_probe', description: 'Return a provider compatibility observation.',
      parameters: { type: 'object', properties: {}, required: [] },
    } }],
    maxOutputTokens: 1,
    ...(typeof parallelToolCalls === 'boolean' ? { parallelToolCalls } : {}),
  };
}

function isOptionalRejection(result) {
  return OPTIONAL_REJECTION_STATUSES.has(result.status)
    || ['provider_image_unsupported', 'provider_tool_schema_rejected'].includes(result.error?.code);
}
