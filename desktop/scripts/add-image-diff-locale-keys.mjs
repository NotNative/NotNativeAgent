// SPDX-License-Identifier: Apache-2.0
/** One-off: add the F6.3 image-diff keys to the 11 gitUi locale catalogs. */
import { readFile, writeFile } from 'node:fs/promises';

const keys = {
  'locale-git-ui-1.ts': {
    deGitUi: ['Vorher (HEAD)', 'Nachher (Arbeitsbaum)', 'Bild-Diff nicht verfügbar.'],
    frGitUi: ['Avant (HEAD)', 'Après (arborescence de travail)', 'Diff d’image indisponible.'],
    zhCNGitUi: ['之前（HEAD）', '之后（工作区）', '图像差异不可用。'],
    zhTWGitUi: ['之前（HEAD）', '之後（工作區）', '影像差異無法使用。'],
  },
  'locale-git-ui-2.ts': {
    ukGitUi: ['До (HEAD)', 'Після (робоче дерево)', 'Порівняння зображень недоступне.'],
    esGitUi: ['Antes (HEAD)', 'Después (árbol de trabajo)', 'Diff de imagen no disponible.'],
    ptBRGitUi: ['Antes (HEAD)', 'Depois (árvore de trabalho)', 'Diff de imagem indisponível.'],
    koGitUi: ['이전(HEAD)', '이후(작업 트리)', '이미지 차이를 사용할 수 없습니다.'],
  },
  'locale-git-ui-3.ts': {
    plGitUi: ['Przed (HEAD)', 'Po (drzewo robocze)', 'Porównanie obrazów niedostępne.'],
    jaGitUi: ['変更前 (HEAD)', '変更後 (作業ツリー)', '画像差分は表示できません。'],
    trGitUi: ['Önce (HEAD)', 'Sonra (çalışma ağacı)', 'Görsel farkı kullanılamıyor.'],
  },
};

const dir = 'packages/ui/src/lib/i18n/messages';
for (const [file, locales] of Object.entries(keys)) {
  const path = `${dir}/${file}`;
  let text = await readFile(path, 'utf8');
  let changed = 0;
  for (const [locale, [original, modified, unavailable]] of Object.entries(locales)) {
    const marker = new RegExp(`(export const ${locale}: PartialDictionary = \\{[\\s\\S]*?'gitUi\\.binaryNoDiff': [^\\n]+\\n)`);
    const match = text.match(marker);
    if (!match || match[1].includes("'gitUi.binaryOriginal'")) continue;
    const addition = `  'gitUi.binaryOriginal': ${JSON.stringify(original)},\n  'gitUi.binaryModified': ${JSON.stringify(modified)},\n  'gitUi.imageDiffUnavailable': ${JSON.stringify(unavailable)},\n`;
    text = text.replace(match[1], match[1] + addition);
    changed += 1;
  }
  await writeFile(path, text);
  console.log(`${file}: ${changed} locales updated`);
}
