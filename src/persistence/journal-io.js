// SPDX-License-Identifier: Apache-2.0
import { open } from 'node:fs/promises';
import { ContractError } from '../ids.js';

export async function missingFinalNewline(path) {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    if (size === 0) return false;
    const last = Buffer.allocUnsafe(1);
    const { bytesRead } = await handle.read(last, 0, 1, size - 1);
    if (bytesRead !== 1) throw new ContractError('persistence_read_incomplete', 'journal final byte could not be read');
    return last[0] !== 0x0a;
  } finally { await handle.close(); }
}

export async function writeFully(handle, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, null);
    if (!Number.isSafeInteger(bytesWritten) || bytesWritten < 1 || bytesWritten > buffer.length - offset) {
      throw new ContractError('persistence_write_incomplete', 'journal write did not make progress');
    }
    offset += bytesWritten;
  }
}
