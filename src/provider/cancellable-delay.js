// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';

export async function cancellableDelay(milliseconds, signal) {
  if (signal.aborted) throw new ContractError('provider_cancelled', 'provider was cancelled');
  await new Promise((resolve, reject) => {
    const completed = () => {
      signal.removeEventListener('abort', cancelled);
      resolve();
    };
    const cancelled = () => {
      clearTimeout(timer);
      reject(new ContractError('provider_cancelled', 'provider was cancelled'));
    };
    const timer = setTimeout(completed, milliseconds);
    signal.addEventListener('abort', cancelled, { once: true });
  });
}
