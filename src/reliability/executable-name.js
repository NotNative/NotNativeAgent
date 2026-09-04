// SPDX-License-Identifier: Apache-2.0

export function portableExecutableName(value) {
  const path = String(value ?? '').trim().replace(/^["']+|["']+$/gu, '').trim().replace(/[\\/]+$/gu, '');
  const name = (path.split(/[\\/]/u).at(-1) ?? '').trim().replace(/^["']+|["']+$/gu, '');
  return name.toLowerCase().replace(/\.(?:exe|cmd|bat|com)$/u, '');
}
