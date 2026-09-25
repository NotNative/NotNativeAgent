// SPDX-License-Identifier: Apache-2.0
/** Fail builds that ship the design tokens but omit the shared UI's utilities. */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'packages', 'web', 'dist');
const htmlFile = path.join(dist, 'index.html');
if (!existsSync(htmlFile)) throw new Error(`web CSS gate: missing ${htmlFile}`);
const html = readFileSync(htmlFile, 'utf8');
const cssAssets = [...html.matchAll(/href="\/assets\/([^"\s]+\.css)"/gu)].map((match) => match[1]);
if (cssAssets.length === 0) throw new Error('web CSS gate: production HTML references no CSS asset');
const css = cssAssets.map((asset) => {
  const file = path.join(dist, 'assets', asset);
  if (!existsSync(file)) throw new Error(`web CSS gate: missing ${file}`);
  return readFileSync(file, 'utf8');
}).join('\n');
const required = [
  ['flex layout', /\.flex\s*\{\s*display\s*:\s*flex\b/u],
  ['grid layout', /\.grid\s*\{\s*display\s*:\s*grid\b/u],
  ['viewport height', /\.h-screen\s*\{\s*height\s*:\s*100vh\b/u],
  ['shared UI neutral background', /\.bg-neutral-900\s*\{/u],
  // The operator rail starts hidden and only becomes visible at xl widths.
  // Generic .flex can be present while this responsive rule is missing.
  ['desktop operator rail breakpoint', /\.xl\\:flex\s*\{\s*display\s*:\s*flex\b/u],
];
const missing = required.filter(([, pattern]) => !pattern.test(css)).map(([label]) => label);
if (missing.length > 0) throw new Error(`web CSS gate: missing generated utilities: ${missing.join(', ')}`);
console.log(`web CSS gate passed (${cssAssets.length} stylesheet${cssAssets.length === 1 ? '' : 's'})`);
