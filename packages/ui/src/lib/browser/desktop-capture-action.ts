// SPDX-License-Identifier: Apache-2.0
/** Capture only the currently observed, isolated Electron preview viewport. */
export interface PageCapture { url: string; mime: 'image/jpeg'; base64: string; width: number; height: number }
type NativeImage = { getSize(): { width: number; height: number }; resize(options: { width: number; height: number }): NativeImage; toJPEG(quality: number): Uint8Array };
type Guest = HTMLElement & { capturePage?: () => Promise<NativeImage> };
interface CaptureContext {
  guest: Guest | null; currentGuest: () => Guest | null; currentUrl: () => string | undefined;
  revision: () => number; observationId: () => string | null;
  otherPending: () => boolean; pending: { current: Promise<unknown> | null }; invalidate: () => void;
}

const MAX_BYTES = 150_000;
const MAX_WIDTH = 1600;
const MAX_HEIGHT = 1200;

export async function executeDesktopCapture(parameters: Record<string, unknown>, state: CaptureContext): Promise<PageCapture> {
  const { expectedUrl, observationRevision, observationId } = parameters;
  if (typeof expectedUrl !== 'string' || !expectedUrl || expectedUrl.length > 2048
    || !Number.isSafeInteger(observationRevision) || (observationRevision as number) < 0
    || typeof observationId !== 'string' || !/^[0-9a-f-]{36}$/u.test(observationId))
    throw new Error('An observed page URL is required for capture.');
  const guest = state.guest;
  if (!guest?.capturePage || state.currentUrl() !== expectedUrl
    || state.revision() !== observationRevision || state.observationId() !== observationId)
    throw new Error('The page changed; take a new snapshot before capture.');
  if (state.otherPending() || state.pending.current)
    throw new Error('A prior browser action may still complete; wait before capture.');
  const bounds = guest.getBoundingClientRect();
  if (bounds.width < 1 || bounds.height < 1)
    throw new Error('The desktop guest is not visible; reveal the Browser pane before capture.');
  state.invalidate();
  const revision = state.revision();
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let image: NativeImage;
  try {
    const execution = guest.capturePage();
    state.pending.current = execution;
    void execution.then(() => { if (state.pending.current === execution) state.pending.current = null; },
      () => { if (state.pending.current === execution) state.pending.current = null; });
    image = await Promise.race([execution,
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Capture timed out; snapshot the page before retrying.')), 15_000); })]);
  } finally { if (timeout) clearTimeout(timeout); }
  if (state.currentGuest() !== guest || state.revision() !== revision || state.currentUrl() !== expectedUrl)
    throw new Error('Capture outcome is uncertain; snapshot the page before retrying.');
  const original = image.getSize();
  if (!Number.isSafeInteger(original.width) || !Number.isSafeInteger(original.height)
    || original.width < 1 || original.height < 1 || original.width > 8192 || original.height > 8192)
    throw new Error('The guest viewport has invalid dimensions.');
  const scale = Math.min(1, MAX_WIDTH / original.width, MAX_HEIGHT / original.height);
  const width = Math.max(1, Math.floor(original.width * scale));
  const height = Math.max(1, Math.floor(original.height * scale));
  const bounded = scale === 1 ? image : image.resize({ width, height });
  for (const quality of [60, 45, 30]) {
    const jpeg = bounded.toJPEG(quality);
    if (jpeg.byteLength > 0 && jpeg.byteLength <= MAX_BYTES) {
      if (state.currentGuest() !== guest || state.revision() !== revision || state.currentUrl() !== expectedUrl)
        throw new Error('Capture outcome is uncertain; snapshot the page before retrying.');
      return { url: expectedUrl, mime: 'image/jpeg', base64: uint8ToBase64(jpeg), width, height };
    }
  }
  throw new Error('The guest viewport could not be captured within the image size limit.');
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}
