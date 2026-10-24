// SPDX-License-Identifier: Apache-2.0
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const REGISTRY = 'docs/architecture/dependency-registry.json';
const MANIFESTS = ['package.json', 'packages/ui/package.json', 'packages/web/package.json'];

export async function auditDependencyRegistry(root, errors) {
  let registry;
  try { registry = JSON.parse(await readFile(join(root, REGISTRY), 'utf8')); }
  catch (error) { errors.push(`dependency registry unreadable: ${error?.message ?? error}`); return; }
  if (!registry || !Array.isArray(registry.dependencies)) {
    errors.push(`dependency registry ${REGISTRY} has an invalid dependencies list`);
    return;
  }
  const declared = await collectDeclaredDependencies(root, errors);
  if (!declared) return;
  const registered = new Set(registry.dependencies.map((entry) => entry.name));
  for (const name of declared) {
    if (!registered.has(name)) errors.push(`runtime dependency '${name}' is missing from ${REGISTRY}`);
  }
  for (const entry of registry.dependencies) {
    if (!declared.has(entry.name)) errors.push(`registry entry '${entry.name}' is not a declared runtime dependency`);
  }
}

async function collectDeclaredDependencies(root, errors) {
  const declared = new Set();
  for (const manifest of MANIFESTS) {
    let pkg;
    try { pkg = JSON.parse(await readFile(join(root, manifest), 'utf8')); }
    catch (error) {
      errors.push(`dependency manifest ${manifest} could not be read or parsed: ${error?.message ?? error}`);
      return null;
    }
    if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)
      || pkg.dependencies !== undefined && (!pkg.dependencies || typeof pkg.dependencies !== 'object' || Array.isArray(pkg.dependencies))) {
      errors.push(`dependency manifest ${manifest} has an invalid dependencies object`);
      return null;
    }
    for (const name of Object.keys(pkg.dependencies ?? {})) declared.add(name);
  }
  return declared;
}
