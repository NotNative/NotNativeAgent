// SPDX-License-Identifier: Apache-2.0

export function portableExecutableName(value) {
  const path = String(value ?? '');
  const name = path.split(/[\\/]/u).at(-1) ?? '';
  return name.toLowerCase().replace(/\.(?:exe|cmd|bat|com)$/u, '');
}
