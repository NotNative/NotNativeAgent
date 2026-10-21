// SPDX-License-Identifier: Apache-2.0

const MAX_STREAM_BYTES = 64 * 1024;

export function completedAssistantHasText(entries, needle) {
  return Array.isArray(entries) && entries.some((entry) => (
    entry?.info?.role === 'assistant'
    && Number.isFinite(entry.info.time?.completed)
    && Array.isArray(entry.parts)
    && entry.parts.some((part) => part?.type === 'text' && typeof part.text === 'string'
      && part.text.includes(needle))
  ));
}

export async function readUntil(reader, timeoutMs, needle, label) {
  const deadline = Date.now() + timeoutMs;
  const decoder = new TextDecoder();
  let text = '', bytes = 0;
  while (bytes < MAX_STREAM_BYTES) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new Error(`${label} timed out after ${timeoutMs} ms`);
    const chunk = await raceTimeout(reader.read(), remainingMs, label);
    const value = chunk.value ?? new Uint8Array();
    bytes += value.byteLength;
    text += decoder.decode(value, { stream: !chunk.done });
    if (text.includes(needle) || chunk.done) return text;
  }
  return text;
}

function raceTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
