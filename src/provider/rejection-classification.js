// SPDX-License-Identifier: Apache-2.0

const IMAGE_UNSUPPORTED_CODES = new Set([
  'unsupported_image', 'image_not_supported', 'unsupported_content_type',
  'unsupported_image_input', 'vision_not_supported', 'multimodal_not_supported',
]);
const REASONING_CONTROL_REJECTION_CODES = new Set([
  'reasoning_effort_unsupported', 'unsupported_reasoning_effort',
  'thinking_mode_unsupported', 'unsupported_thinking_mode',
]);
const CONTEXT_LIMIT_CODES = new Set([
  'context_length_exceeded', 'context_window_exceeded', 'context_size_exceeded',
  'input_too_long', 'prompt_too_long', 'max_context_length_exceeded',
  'maximum_context_length_exceeded', 'tokens_exceeded',
]);

export function isImageUnsupportedError(value) {
  const fields = boundedErrorStrings(value);
  if (fields.some((item) => IMAGE_UNSUPPORTED_CODES.has(normalizedCode(item)))) return true;
  const text = fields.join(' ').toLowerCase();
  return [
    /(?:image|vision|multimodal).{0,64}(?:not supported|unsupported|not available|not enabled)/u,
    /(?:does not|doesn't|cannot|can't).{0,48}(?:support|accept|process).{0,32}(?:image|vision|multimodal)/u,
    /(?:unsupported|invalid) content (?:type|part).{0,48}image/u,
    /(?:text[- ]only|only supports? text).{0,48}(?:model|input|content)?/u,
  ].some((pattern) => pattern.test(text));
}

export function isReasoningControlRejection(value) {
  const fields = boundedErrorStrings(value);
  if (fields.some((item) => REASONING_CONTROL_REJECTION_CODES.has(normalizedCode(item)))) return true;
  const text = fields.join(' ').toLowerCase();
  return [
    /(?:reasoning_effort|reasoning effort|enable_thinking|thinking mode).{0,64}(?:not supported|unsupported|invalid)/u,
    /(?:does not|doesn't|cannot|can't).{0,64}support.{0,32}(?:disabling thinking|reasoning_effort|reasoning effort|enable_thinking)/u,
  ].some((pattern) => pattern.test(text));
}

export function isGrammarFailure(value) {
  const text = boundedErrorStrings(value).join(' ').toLowerCase();
  return /(?:failed|error).{0,64}(?:parse|compile).{0,32}grammar/u.test(text)
    || /failed to initialize samplers.{0,96}grammar/u.test(text);
}

export function isContextLimitError(value) {
  const fields = boundedErrorStrings(value);
  if (fields.some((item) => CONTEXT_LIMIT_CODES.has(normalizedCode(item)))) return true;
  const text = fields.join(' ').toLowerCase();
  return [
    /(?:maximum|max) context (?:length|window|size).{0,96}(?:exceed|token|larger|greater)/u,
    /context (?:length|window|size).{0,96}(?:exceed|too (?:long|large)|overflow|limit)/u,
    /(?:input|prompt).{0,64}(?:too (?:long|large)|exceed).{0,64}(?:context|token|limit|length)/u,
    /(?:requested|provided|input).{0,64}(?:tokens?|token count).{0,96}(?:exceed|greater|larger|maximum|max)/u,
    /(?:number|amount) of tokens.{0,96}(?:exceed|greater|larger|context)/u,
    /request.{0,64}exceed.{0,96}(?:available )?context (?:length|window|size)/u,
    /(?:kv|k-v) cache.{0,64}(?:insufficient|not enough|exhausted).{0,64}(?:context|token|capacity)?/u,
  ].some((pattern) => pattern.test(text));
}

function boundedErrorStrings(value) {
  const result = []; const pending = [value]; let visited = 0; let bytes = 0;
  while (pending.length > 0 && visited < 128 && bytes < 32_768) {
    const item = pending.pop(); visited += 1;
    if (typeof item === 'string' || typeof item === 'number') {
      const text = String(item).slice(0, 4096); bytes += Buffer.byteLength(text, 'utf8'); result.push(text);
    } else if (item && typeof item === 'object') {
      pending.push(...Object.values(item).slice(0, 32));
    }
  }
  return result;
}

function normalizedCode(value) {
  return value.toLowerCase().replaceAll('-', '_');
}
