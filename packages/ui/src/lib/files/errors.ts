// SPDX-License-Identifier: Apache-2.0
/** Transport-neutral errors shared by file UI and host adapters. */
export class FileReadError extends Error {
  constructor(message: string, readonly status: number, readonly reason?: string) {
    super(message);
    this.name = 'FileReadError';
  }
}

export class FileWriteConflictError extends Error {
  constructor(message: string, readonly safety: 'changed' | 'unknown' = 'changed') {
    super(message);
    this.name = 'FileWriteConflictError';
  }
}
