// SPDX-License-Identifier: Apache-2.0
import { expect, it } from 'vitest';
import { reviewModeSnapshot } from '../review-mode.ts';
const valid = { mode: 'default', effective: 'auto-review', revision: 0,
  defaultMode: 'auto-review', availableModes: ['default', 'auto-review', 'unattended'] };
it('requires internally consistent, bounded NNA mode snapshots', () => {
  expect(reviewModeSnapshot(valid)).toEqual(valid);
  for (const change of [{ revision: -1 }, { revision: 1.2 }, { revision: Number.MAX_SAFE_INTEGER + 1 },
    { mode: 'full-control' }, { effective: 'unattended' }, { defaultMode: 'unattended' },
    { availableModes: [] }, { availableModes: ['default', 'default'] },
    { availableModes: ['auto-review'] }, { availableModes: ['default', 'full-control'] }]) {
    expect(reviewModeSnapshot({ ...valid, ...change })).toBeNull();
  }
  for (const input of [null, undefined, 'default', [], 1]) expect(reviewModeSnapshot(input)).toBeNull();
});
