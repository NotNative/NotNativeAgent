// SPDX-License-Identifier: Apache-2.0
import { expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { describeSendFailure } from '../composer-attachments.ts';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

it('shows actionable native workspace refusal while the composer restores its draft', () => {
  const message = 'NNA is attached to D:/repo/A. Select that workspace or reconfigure NNA before creating a session.';
  describeSendFailure(new Error(message), false);
  expect(toast.error).toHaveBeenCalledWith(message);
});
