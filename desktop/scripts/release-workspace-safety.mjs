// SPDX-License-Identifier: Apache-2.0
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const MANIFESTS = ['package.json', 'packages/ui/package.json', 'packages/web/package.json'];

export async function checkWorkspaceSafety(root, errors) {
  for (const manifest of MANIFESTS) {
    let packageJson;
    try { packageJson = JSON.parse(await readFile(join(root, ...manifest.split('/')), 'utf8')); }
    catch (error) {
      errors.push(`${manifest} could not be read as JSON: ${error.code ?? error.message}`);
      continue;
    }
    if (!packageJson || typeof packageJson !== 'object' || Array.isArray(packageJson)) {
      errors.push(`${manifest} must contain a JSON object`);
    } else if (packageJson.private !== true) {
      errors.push(`${manifest} must stay private:true`);
    }
  }
}
