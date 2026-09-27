// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { expect, it } from 'vitest';
import { formatRegionDraft, parsePageRegion, regionScript } from '../region-annotation.ts';
import { annotationCheckScript } from '../annotation-capture.ts';

it('selects a bounded region in guest CSS pixels without modifying the page', () => {
  const script = regionScript(location.href, [0.1, 0.2, 0.5, 0.6]);
  const value = new Function(`return ${script}`)();
  const region = parsePageRegion(value);
  expect(region).toMatchObject({ kind: 'region', url: location.href });
  expect(region!.bounds.x).toBeCloseTo(innerWidth * 0.1);
  expect(region!.bounds.y).toBeCloseTo(innerHeight * 0.2);
  expect(region!.bounds.width).toBeCloseTo(innerWidth * 0.4);
  expect(region!.bounds.height).toBeCloseTo(innerHeight * 0.4);
  expect(document.querySelector('[data-nnd-annotation]')).toBeNull();
  expect(new Function(`return ${annotationCheckScript(region!)}`)()).toBe(true);
  expect(new Function(`return ${regionScript('https://different.example/', [0.1, 0.2, 0.5, 0.6])}`)()).toBeNull();
  expect(new Function(`return ${regionScript(location.href, [0.1, 0.2, 0.101, 0.6])}`)()).toBeNull();
  expect(formatRegionDraft(region!, 'Fix layout')).toContain('User comment: Fix layout');
});

it('rejects forged or outside-viewport region metadata', () => {
  const value = new Function(`return ${regionScript(location.href, [0.1, 0.2, 0.5, 0.6])}`)();
  expect(parsePageRegion({ ...value, bounds: { x: 1, y: 1, width: Infinity, height: 10 } })).toBeNull();
  expect(parsePageRegion({ ...value, bounds: { x: innerWidth - 1, y: 1, width: 20, height: 20 } })).toBeNull();
  expect(parsePageRegion({ ...value, kind: 'element' })).toBeNull();
});
