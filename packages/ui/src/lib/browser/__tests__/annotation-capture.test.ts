// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from 'vitest';
import { annotationCheckScript, captureAnnotationImage, renderAnnotationImage } from '../annotation-capture.ts';
import type { PageAnnotation } from '../page-annotation.ts';
import type { RegionAnnotation } from '../region-annotation.ts';

const annotation: PageAnnotation = { url: 'https://example.org/', tag: 'button', selector: 'button', label: 'Save',
  bounds: { x: 10, y: 20, width: 30, height: 40 },
  viewport: { width: 400, height: 300, scrollX: 0, scrollY: 0 } };

afterEach(() => vi.restoreAllMocks());

it('checks the exact page, viewport, scroll and current element geometry', () => {
  const button = document.createElement('button');
  button.textContent = 'Save';
  button.getBoundingClientRect = () => ({ x: 10, y: 20, width: 30, height: 40 } as DOMRect);
  document.body.append(button);
  const selected = { ...annotation, url: location.href,
    viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY } };
  const execute = (): boolean => new Function(`return ${annotationCheckScript(selected)}`)() as boolean;
  expect(execute()).toBe(true);
  button.textContent = 'Delete';
  expect(execute()).toBe(false);
  button.textContent = 'Save';
  button.getBoundingClientRect = () => ({ x: 10, y: 30, width: 30, height: 40 } as DOMRect);
  expect(execute()).toBe(false);
  button.remove();
});

it('rejects a moved element after the guest capture without emitting an attachment', async () => {
  const executeJavaScript = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  const capturePage = vi.fn().mockResolvedValue({ getSize: () => ({ width: 800, height: 600 }) });
  const guest = { executeJavaScript, capturePage } as never;
  await expect(captureAnnotationImage(guest, annotation, () => true)).rejects.toThrow('page changed');
  expect(capturePage).toHaveBeenCalledOnce();
  expect(executeJavaScript).toHaveBeenCalledTimes(2);
});

it('composes the full viewport with measured capture/CSS ratios and a resolved accent', async () => {
  const fillRect = vi.fn(); const strokeRect = vi.fn(); const drawImage = vi.fn();
  const context = { fillRect, strokeRect, drawImage, fillStyle: '', strokeStyle: '', lineWidth: 0 };
  const canvas = document.createElement('canvas');
  vi.spyOn(canvas, 'getContext').mockReturnValue(context as never);
  vi.spyOn(canvas, 'toDataURL').mockReturnValue('data:image/jpeg;base64,AA==');
  const create = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation((name: string) => name === 'canvas' ? canvas : create(name));
  const originalImage = globalThis.Image;
  globalThis.Image = class { src = ''; async decode(): Promise<void> {} } as never;
  try {
    const rendered = await renderAnnotationImage({ getSize: () => ({ width: 800, height: 600 }),
      toJPEG: () => new Uint8Array([255, 216, 255]) }, annotation);
    expect(canvas.width).toBe(800);
    expect(canvas.height).toBe(600);
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 800, 600);
    expect(fillRect).toHaveBeenCalledWith(20, 40, 60, 80);
    expect(strokeRect).toHaveBeenCalledWith(20, 40, 60, 80);
    expect(context.fillStyle).toBe('rgba(14, 165, 233, 0.18)');
    expect(rendered.dataUrl).toBe('data:image/jpeg;base64,AA==');
  } finally { globalThis.Image = originalImage; }
});

it('rejects oversized capture dimensions before decoding', async () => {
  await expect(renderAnnotationImage({ getSize: () => ({ width: 6000, height: 4000 }),
    toJPEG: () => new Uint8Array([1]) }, annotation)).rejects.toThrow('invalid dimensions');
});

it('composites a drawn region using the measured image-to-CSS ratio', async () => {
  const region: RegionAnnotation = { kind: 'region', url: 'https://example.org/',
    bounds: { x: 20, y: 30, width: 40, height: 50 },
    viewport: { width: 400, height: 300, scrollX: 0, scrollY: 0 } };
  const fillRect = vi.fn(); const strokeRect = vi.fn();
  const canvas = document.createElement('canvas');
  vi.spyOn(canvas, 'getContext').mockReturnValue({ drawImage: vi.fn(), fillRect, strokeRect } as never);
  vi.spyOn(canvas, 'toDataURL').mockReturnValue('data:image/jpeg;base64,AA==');
  const create = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation((name: string) => name === 'canvas' ? canvas : create(name));
  const originalImage = globalThis.Image;
  globalThis.Image = class { src = ''; async decode(): Promise<void> {} } as never;
  try {
    await renderAnnotationImage({ getSize: () => ({ width: 800, height: 600 }),
      toJPEG: () => new Uint8Array([255, 216, 255]) }, region);
    expect(fillRect).toHaveBeenCalledWith(40, 60, 80, 100);
    expect(strokeRect).toHaveBeenCalledWith(40, 60, 80, 100);
  } finally { globalThis.Image = originalImage; }
});
