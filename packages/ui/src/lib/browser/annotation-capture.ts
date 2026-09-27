// SPDX-License-Identifier: Apache-2.0
/** Bounded, same-page user annotation capture. Never captures the host shell. */
import type { PageAnnotation } from './page-annotation.ts';
import type { RegionAnnotation } from './region-annotation.ts';

type Selection = PageAnnotation | RegionAnnotation;

type NativeImage = { getSize(): { width: number; height: number }; toJPEG(quality: number): Uint8Array };
export type AnnotationGuest = HTMLElement & {
  executeJavaScript?: (script: string, userGesture?: boolean) => Promise<unknown>;
  capturePage?: () => Promise<NativeImage>; getURL?: () => string;
};
export interface AnnotationImage { name: string; mime: 'image/jpeg'; dataUrl: string }

function sameElement(annotation: PageAnnotation): boolean {
  if (location.href !== annotation.url || window.innerWidth !== annotation.viewport.width
    || window.innerHeight !== annotation.viewport.height
    || Math.abs(window.scrollX - annotation.viewport.scrollX) > 1
    || Math.abs(window.scrollY - annotation.viewport.scrollY) > 1) return false;
  const element = document.querySelector(annotation.selector);
  if (!element || element.tagName.toLowerCase() !== annotation.tag) return false;
  const editable = element.matches('input,textarea,select,[contenteditable]') || !!element.closest('[contenteditable]')
    || !!element.querySelector('input,textarea,select,[contenteditable]');
  const label = (editable ? '' : (element.getAttribute('aria-label') || element.getAttribute('title')
    || (element instanceof HTMLElement ? element.innerText : '') || element.textContent || ''))
    .replace(/\s+/gu, ' ').trim().slice(0, 200);
  if (label !== annotation.label) return false;
  const actual = element.getBoundingClientRect();
  return (['x', 'y', 'width', 'height'] as const).every((field) =>
    Math.abs(actual[field] - annotation.bounds[field]) <= 2);
}

function sameRegion(annotation: RegionAnnotation): boolean {
  return location.href === annotation.url && window.innerWidth === annotation.viewport.width
    && window.innerHeight === annotation.viewport.height
    && Math.abs(window.scrollX - annotation.viewport.scrollX) <= 1
    && Math.abs(window.scrollY - annotation.viewport.scrollY) <= 1;
}

export function annotationCheckScript(annotation: Selection): string {
  return 'kind' in annotation
    ? `(${sameRegion.toString()})(${JSON.stringify(annotation)})`
    : `(${sameElement.toString()})(${JSON.stringify(annotation)})`;
}

async function bounded<T>(task: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([task, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Screenshot capture timed out. Try selecting the element again.')), 15_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 8192)
    binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return btoa(binary);
}

async function decodeJpeg(bytes: Uint8Array): Promise<HTMLImageElement> {
  const image = new Image();
  image.src = `data:image/jpeg;base64,${bytesToBase64(bytes)}`;
  await bounded(image.decode());
  return image;
}

export async function renderAnnotationImage(image: NativeImage, annotation: Selection): Promise<AnnotationImage> {
  const size = image.getSize();
  if (!Number.isSafeInteger(size.width) || !Number.isSafeInteger(size.height)
    || size.width < 1 || size.height < 1 || size.width > 8192 || size.height > 8192
    || size.width * size.height > 4_000_000) throw new Error('The captured viewport has invalid dimensions.');
  const jpeg = image.toJPEG(70);
  if (!jpeg.byteLength || jpeg.byteLength > 1_000_000) throw new Error('The captured viewport exceeds the image limit.');
  const source = await decodeJpeg(jpeg);
  const scale = Math.min(1, 1600 / size.width, 1200 / size.height);
  const width = Math.max(1, Math.floor(size.width * scale));
  const height = Math.max(1, Math.floor(size.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Screenshot composition is unavailable.');
  context.drawImage(source, 0, 0, width, height);
  const ratioX = width / annotation.viewport.width;
  const ratioY = height / annotation.viewport.height;
  const { x, y, width: boxWidth, height: boxHeight } = annotation.bounds;
  context.fillStyle = 'rgba(14, 165, 233, 0.18)';
  context.strokeStyle = '#0ea5e9';
  context.lineWidth = Math.max(2, width / 600);
  context.fillRect(x * ratioX, y * ratioY, boxWidth * ratioX, boxHeight * ratioY);
  context.strokeRect(x * ratioX, y * ratioY, boxWidth * ratioX, boxHeight * ratioY);
  for (const quality of [0.85, 0.65, 0.45, 0.3]) {
    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    if (/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/u.test(dataUrl)
      && (dataUrl.length - 23) * 3 / 4 <= 150_000)
      return { name: `browser-annotation-${Date.now()}-${crypto.randomUUID()}.jpg`, mime: 'image/jpeg', dataUrl };
  }
  throw new Error('The highlighted screenshot exceeds the attachment limit.');
}

export async function captureAnnotationImage(guest: AnnotationGuest, annotation: Selection,
  stillCurrent: () => boolean): Promise<AnnotationImage> {
  if (!guest.capturePage || !guest.executeJavaScript || !stillCurrent())
    throw new Error('The page changed during annotation. Select the element again.');
  const check = annotationCheckScript(annotation);
  if (await bounded(guest.executeJavaScript(check, false)) !== true || !stillCurrent())
    throw new Error('The page or selected element moved. Select it again.');
  const image = await bounded(guest.capturePage());
  if (!stillCurrent() || await bounded(guest.executeJavaScript(check, false)) !== true || !stillCurrent())
    throw new Error('The page changed during screenshot capture. Select the element again.');
  const result = await renderAnnotationImage(image, annotation);
  if (!stillCurrent()) throw new Error('The page changed during screenshot capture. Select the element again.');
  return result;
}
