// SPDX-License-Identifier: Apache-2.0
/** One-off: split the oversized gitUi locale catalogs (gate cap 500 lines). */
import { readFileSync, writeFileSync } from 'node:fs';

const dir = 'packages/ui/src/lib/i18n/messages/';
const header = '// SPDX-License-Identifier: Apache-2.0\n';

function split(file, lastExport) {
  const path = dir + file;
  const text = readFileSync(path, 'utf8');
  const at = text.indexOf(lastExport);
  if (at < 0) throw new Error(`${lastExport} not in ${file}`);
  const block = text.slice(at);
  writeFileSync(path, text.slice(0, at).replace(/\s*$/, '\n'));
  return block;
}

const zhTW = split('locale-git-ui-1.ts', 'export const zhTWGitUi');
const ko = split('locale-git-ui-2.ts', 'export const koGitUi');
writeFileSync(dir + 'locale-git-ui-4.ts', `${header}\n${zhTW}\n${ko}`);

const aggPath = dir + 'locale-git-ui.ts';
let agg = readFileSync(aggPath, 'utf8');
agg = agg.replace("export { deGitUi, frGitUi, zhCNGitUi, zhTWGitUi } from './locale-git-ui-1.ts';", "export { deGitUi, frGitUi, zhCNGitUi } from './locale-git-ui-1.ts';");
agg = agg.replace("export { ukGitUi, esGitUi, ptBRGitUi, koGitUi } from './locale-git-ui-2.ts';", "export { ukGitUi, esGitUi, ptBRGitUi } from './locale-git-ui-2.ts';\nexport { zhTWGitUi, koGitUi } from './locale-git-ui-4.ts';");
writeFileSync(aggPath, agg);
console.log('split done');
