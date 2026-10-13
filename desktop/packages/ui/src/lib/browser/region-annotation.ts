// SPDX-License-Identifier: Apache-2.0
/** Read-only viewport metadata for a region drawn on the host-owned shield. */
export interface RegionAnnotation {
  kind: 'region'; url: string;
  bounds: { x: number; y: number; width: number; height: number };
  viewport: { width: number; height: number; scrollX: number; scrollY: number };
}

export function selectPageRegion(expectedUrl: string, fractions: number[]): RegionAnnotation | null {
  if (location.href !== expectedUrl || fractions.length !== 4
    || fractions.some((part) => !Number.isFinite(part) || part < 0 || part > 1)) return null;
  const [left, top, right, bottom] = fractions as [number, number, number, number];
  const width = (right - left) * window.innerWidth;
  const height = (bottom - top) * window.innerHeight;
  if (width < 8 || height < 8) return null;
  return { kind: 'region', url: location.href,
    bounds: { x: left * window.innerWidth, y: top * window.innerHeight, width, height },
    viewport: { width: window.innerWidth, height: window.innerHeight,
      scrollX: window.scrollX, scrollY: window.scrollY } };
}

export function regionScript(expectedUrl: string, fractions: number[]): string {
  return `(${selectPageRegion.toString()})(${JSON.stringify(expectedUrl)}, ${JSON.stringify(fractions)})`;
}

export function parsePageRegion(value: unknown): RegionAnnotation | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<RegionAnnotation>;
  const bounds = item.bounds; const viewport = item.viewport;
  return item.kind === 'region' && typeof item.url === 'string' && item.url.length > 0 && item.url.length <= 2048
    && !!bounds && ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(bounds[key as keyof typeof bounds])
      && Math.abs(bounds[key as keyof typeof bounds]) <= 100_000)
    && bounds.width >= 8 && bounds.height >= 8 && !!viewport
    && Number.isSafeInteger(viewport.width) && Number.isSafeInteger(viewport.height)
    && viewport.width >= 1 && viewport.height >= 1 && viewport.width <= 8192 && viewport.height <= 8192
    && Number.isFinite(viewport.scrollX) && Number.isFinite(viewport.scrollY)
    && Math.abs(viewport.scrollX) <= 100_000 && Math.abs(viewport.scrollY) <= 100_000
    && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width + 1
    && bounds.y + bounds.height <= viewport.height + 1 ? item as RegionAnnotation : null;
}

export function formatRegionDraft(annotation: RegionAnnotation, comment: string): string {
  const { x, y, width, height } = annotation.bounds;
  return `Page annotation (user-drawn region; highlighted viewport screenshot attached)\nPage: ${annotation.url}\nViewport region: ${Math.round(x)}, ${Math.round(y)}, ${Math.round(width)} × ${Math.round(height)}\nUser comment: ${comment.trim().slice(0, 2000)}`;
}
