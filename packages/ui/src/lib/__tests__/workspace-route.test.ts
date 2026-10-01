// SPDX-License-Identifier: Apache-2.0
import { expect, it } from 'vitest';
import { parseWorkspaceRoute, workspaceRouteUrl } from '../workspace-route.ts';
it('resolves lowercase settings, aliases and unknown pages at the catalog boundary', () => {
  for (const slug of ['GENERAL', 'home', 'preferences', 'openchamber', 'unknown']) expect(parseWorkspaceRoute(`?settings=${slug}`).settings).toBe('general');
  expect(parseWorkspaceRoute('?settings=APPEARANCE').settings).toBe('appearance');
  expect(parseWorkspaceRoute('?settings=')).toMatchObject({ settings: null });
});
it('decodes bounded legacy fields and tolerates invalid or absent values', () => {
  expect(parseWorkspaceRoute('?session=s%2Fa&tab=diff&file=src%2Fa%20b.ts')).toEqual({ session: 's/a', tab: 'diff', file: 'src/a b.ts', settings: null });
  expect(parseWorkspaceRoute('?session=%00&tab=unknown&file=%00')).toEqual({ session: null, tab: null, file: null, settings: null });
});
it('serializes only settings or session while preserving host fields and hash', () => {
  const href = 'https://nnd.example/?session=old&settings=old&tab=git&file=x&startupTrace=1#anchor';
  expect(workspaceRouteUrl(href, 's/a', 'appearance').href).toBe('https://nnd.example/?startupTrace=1&settings=appearance#anchor');
  expect(workspaceRouteUrl(href, 's/a', null).href).toBe('https://nnd.example/?startupTrace=1&session=s%2Fa#anchor');
});
