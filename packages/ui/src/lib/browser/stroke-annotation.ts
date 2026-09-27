// SPDX-License-Identifier: Apache-2.0
/** Read-only viewport metadata for host-owned freehand marks. */
export interface StrokeAnnotation {
  kind: 'stroke'; url: string; strokes: Array<Array<{ x: number; y: number }>>;
  viewport: { width: number; height: number; scrollX: number; scrollY: number };
}

export function selectPageStrokes(expectedUrl: string, strokes: number[][][]): StrokeAnnotation | null {
  if (location.href !== expectedUrl || strokes.length < 1 || strokes.length > 8
    || strokes.some((stroke) => stroke.length < 2 || stroke.length > 128
      || stroke.some((point) => point.length !== 2 || point.some((part) =>
        !Number.isFinite(part) || part < 0 || part > 1)))) return null;
  const width = window.innerWidth; const height = window.innerHeight;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
    || width < 1 || height < 1 || width > 8192 || height > 8192) return null;
  const converted = strokes.map((stroke) => stroke.map(([x, y]) => ({ x: x! * width, y: y! * height })));
  if (converted.some((stroke) => stroke.slice(1).reduce((distance, point, index) =>
    distance + Math.hypot(point.x - stroke[index]!.x, point.y - stroke[index]!.y), 0) < 8)) return null;
  return { kind: 'stroke', url: location.href, strokes: converted,
    viewport: { width, height, scrollX: window.scrollX, scrollY: window.scrollY } };
}

export function strokeScript(expectedUrl: string, strokes: number[][][]): string {
  return `(${selectPageStrokes.toString()})(${JSON.stringify(expectedUrl)}, ${JSON.stringify(strokes)})`;
}

export function parsePageStrokes(value: unknown): StrokeAnnotation | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<StrokeAnnotation>; const viewport = item.viewport;
  if (item.kind !== 'stroke' || typeof item.url !== 'string' || !item.url || item.url.length > 2048
    || !viewport || !Number.isSafeInteger(viewport.width) || !Number.isSafeInteger(viewport.height)
    || viewport.width < 1 || viewport.height < 1 || viewport.width > 8192 || viewport.height > 8192
    || !Number.isFinite(viewport.scrollX) || !Number.isFinite(viewport.scrollY)
    || Math.abs(viewport.scrollX) > 100_000 || Math.abs(viewport.scrollY) > 100_000
    || !Array.isArray(item.strokes) || item.strokes.length < 1 || item.strokes.length > 8) return null;
  for (const stroke of item.strokes) {
    if (!Array.isArray(stroke) || stroke.length < 2 || stroke.length > 128) return null;
    if (stroke.some((point) => !point || !Number.isFinite(point.x) || !Number.isFinite(point.y)
      || point.x < 0 || point.y < 0 || point.x > viewport.width || point.y > viewport.height)) return null;
    if (stroke.slice(1).reduce((distance, point, index) =>
      distance + Math.hypot(point.x - stroke[index]!.x, point.y - stroke[index]!.y), 0) < 8) return null;
  }
  return item as StrokeAnnotation;
}

export function formatStrokeDraft(annotation: StrokeAnnotation, comment: string): string {
  return `Page annotation (user-drawn freehand strokes; marked viewport screenshot attached)\nPage: ${annotation.url}\nStrokes: ${annotation.strokes.length}; points: ${annotation.strokes.map((stroke) => stroke.length).join(', ')}\nViewport: ${annotation.viewport.width} × ${annotation.viewport.height}\nUser comment: ${comment.trim().slice(0, 2000)}`;
}
