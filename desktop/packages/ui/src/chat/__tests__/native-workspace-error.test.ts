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

it('narrates the NNA busy refusal with the recovery and never a generic failure', () => {
  describeSendFailure({ status: 409, message: 'NND session already has an active turn' }, false);
  expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('running a turn'));
  expect(toast.error).not.toHaveBeenCalledWith('Message failed to send. Your text was restored.');
});
