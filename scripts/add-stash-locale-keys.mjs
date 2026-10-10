// SPDX-License-Identifier: Apache-2.0
/** One-off: add the F6.3 stash keys to the 11 gitUi locale catalogs. */
import { readFile, writeFile } from 'node:fs/promises';

const KEYS = ['gitUi.stashes', 'gitUi.stashes.title', 'gitUi.stashes.create', 'gitUi.stashes.apply', 'gitUi.stashes.drop', 'gitUi.stashes.empty', 'gitUi.stashes.failed'];

// [label, title, create, apply, drop, empty, failed]
const locales = {
  'locale-git-ui-1.ts': {
    deGitUi: ['Stashes', 'Stashes', 'Änderungen stashen', 'Anwenden', 'Löschen', 'Keine Stashes.', 'Stash-Vorgang fehlgeschlagen.'],
    frGitUi: ['Stashes', 'Stashes', 'Stasher les modifications', 'Appliquer', 'Supprimer', 'Aucun stash.', 'Échec de l’opération de stash.'],
    zhCNGitUi: ['贮藏', '贮藏', '贮藏更改', '应用', '丢弃', '没有贮藏。', '贮藏操作失败。'],
    zhTWGitUi: ['貯藏', '貯藏', '貯藏變更', '套用', '捨棄', '沒有貯藏。', '貯藏操作失敗。'],
  },
  'locale-git-ui-2.ts': {
    ukGitUi: ['Сховище', 'Сховище', 'Сховати зміни', 'Застосувати', 'Видалити', 'Сховищ немає.', 'Помилка операції сховища.'],
    esGitUi: ['Stashes', 'Stashes', 'Guardar cambios en stash', 'Aplicar', 'Descartar', 'No hay stashes.', 'La operación de stash falló.'],
    ptBRGitUi: ['Stashes', 'Stashes', 'Guardar alterações em stash', 'Aplicar', 'Descartar', 'Nenhum stash.', 'Falha na operação de stash.'],
    koGitUi: ['스태시', '스태시', '변경 스태시', '적용', '삭제', '스태시가 없습니다.', '스태시 작업에 실패했습니다.'],
  },
  'locale-git-ui-3.ts': {
    plGitUi: ['Schowki', 'Schowki', 'Schowaj zmiany', 'Zastosuj', 'Usuń', 'Brak schowków.', 'Operacja schowka nie powiodła się.'],
    jaGitUi: ['スタッシュ', 'スタッシュ', '変更をスタッシュ', '適用', '削除', 'スタッシュはありません。', 'スタッシュ操作に失敗しました。'],
    trGitUi: ['Stash’lar', 'Stash’lar', 'Değişiklikleri stash’la', 'Uygula', 'Sil', 'Stash yok.', 'Stash işlemi başarısız oldu.'],
  },
};

const dir = 'packages/ui/src/lib/i18n/messages';
for (const [file, blocks] of Object.entries(locales)) {
  const path = `${dir}/${file}`;
  let text = await readFile(path, 'utf8');
  let changed = 0;
  for (const [locale, values] of Object.entries(blocks)) {
    const marker = new RegExp(`(export const ${locale}: PartialDictionary = \\{\\r?\\n)`);
    const match = text.match(marker);
    const blockStart = match ? match.index + match[1].length : -1;
    const nextExport = text.indexOf('export const', blockStart);
    const block = blockStart >= 0 ? text.slice(blockStart, nextExport < 0 ? text.length : nextExport) : '';
    if (blockStart < 0 || block.includes("'gitUi.stashes.title'")) continue;
    const addition = KEYS.map((key, at) => `  '${key}': ${JSON.stringify(values[at])},`).join('\n') + '\n';
    text = text.replace(match[1], match[1] + addition);
    changed += 1;
  }
  await writeFile(path, text);
  console.log(`${file}: ${changed} locales updated`);
}
