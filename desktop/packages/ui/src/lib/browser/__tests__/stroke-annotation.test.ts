// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { expect, it } from 'vitest';
import { annotationCheckScript } from '../annotation-capture.ts';
import { formatStrokeDraft, parsePageStrokes, strokeScript } from '../stroke-annotation.ts';

it('reads same-page freehand points as bounded guest CSS coordinates', () => {
  const strokes = [[[0.1, 0.2], [0.5, 0.6]], [[0.7, 0.2], [0.8, 0.3]]];
  const value = new Function(`return ${strokeScript(location.href, strokes)}`)();
  const annotation = parsePageStrokes(value);
  expect(annotation).toMatchObject({ kind: 'stroke', url: location.href, strokes: [
    [{ x: innerWidth * 0.1, y: innerHeight * 0.2 }, { x: innerWidth * 0.5, y: innerHeight * 0.6 }],
    [{ x: innerWidth * 0.7, y: innerHeight * 0.2 }, { x: innerWidth * 0.8, y: innerHeight * 0.3 }],
  ] });
  expect(new Function(`return ${annotationCheckScript(annotation!)}`)()).toBe(true);
  expect(new Function(`return ${strokeScript('https://other.example/', strokes)}`)()).toBeNull();
  expect(formatStrokeDraft(annotation!, 'Check this')).toContain('User comment: Check this');
});

it('rejects tiny, overlong, nonfinite, and out-of-viewport marks', () => {
  const tiny = new Function(`return ${strokeScript(location.href, [[[0.1, 0.2], [0.101, 0.201]]])}`)();
  expect(tiny).toBeNull();
  const large = Array.from({ length: 9 }, () => [[0.1, 0.2], [0.5, 0.6]]);
  expect(new Function(`return ${strokeScript(location.href, large)}`)()).toBeNull();
  expect(parsePageStrokes({ kind: 'stroke', url: location.href, viewport: {
    width: 100, height: 100, scrollX: 0, scrollY: 0 }, strokes: [[{ x: 10, y: 10 }, { x: 101, y: 50 }]] })).toBeNull();
  expect(parsePageStrokes({ kind: 'stroke', url: location.href, viewport: {
    width: 100, height: 100, scrollX: 0, scrollY: 0 }, strokes: [[{ x: NaN, y: 10 }, { x: 50, y: 50 }]] })).toBeNull();
});
