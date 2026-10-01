// SPDX-License-Identifier: Apache-2.0
/**
 * Non-English catalogs (doc 14 §H.2, delta E2): P5-4 ships en complete and
 * the 11 other locales as partial catalogs — the resolve chain falls back
 * per key to en (lib/i18n/context), and the closed `I18nKey` from en.ts
 * makes impossible keys a type error. Per-locale parity is authoring work;
 * the per-locale file split (<locale>.settings.ts) lands with the settings
 * volumes that need it.
 */
import type { PartialDictionary } from './en.ts';

export const de: PartialDictionary = {
  'app.title': 'NotNativeDesktop',
  'bootstrap.loading': 'NotNativeDesktop wird geladen…',
  'shell.sessions': 'Sitzungen',
  'shell.newSession': 'Neue Sitzung',
  'shell.send': 'Senden',
  'shell.noSession': 'Keine Sitzung ausgewählt',
  'shell.recovery.retry': 'Erneut versuchen',
};

export const fr: PartialDictionary = {
  'app.title': 'NotNativeDesktop',
  'bootstrap.loading': 'Chargement de NotNativeDesktop…',
  'shell.sessions': 'Sessions',
  'shell.newSession': 'Nouvelle session',
  'shell.send': 'Envoyer',
  'shell.noSession': 'Aucune session sélectionnée',
  'shell.recovery.retry': 'Réessayer',
};

export const zhCN: PartialDictionary = {
  'app.title': 'NotNativeDesktop',
  'bootstrap.loading': '正在加载 NotNativeDesktop…',
  'shell.sessions': '会话',
  'shell.newSession': '新建会话',
  'shell.send': '发送',
  'shell.noSession': '未选择会话',
  'shell.recovery.retry': '重试',
};

export const zhTW: PartialDictionary = {
  'app.title': 'NotNativeDesktop',
  'bootstrap.loading': '正在載入 NotNativeDesktop…',
  'shell.sessions': '工作階段',
  'shell.newSession': '新增工作階段',
  'shell.send': '傳送',
  'shell.noSession': '未選擇工作階段',
  'shell.recovery.retry': '重試',
};

export const uk: PartialDictionary = {
  'app.title': 'NotNativeDesktop',
  'bootstrap.loading': 'Завантаження NotNativeDesktop…',
  'shell.sessions': 'Сесії',
  'shell.newSession': 'Нова сесія',
  'shell.send': 'Надіслати',
  'shell.noSession': 'Сесію не вибрано',
  'shell.recovery.retry': 'Спробувати знову',
};

export const es: PartialDictionary = {
  'app.title': 'NotNativeDesktop',
  'bootstrap.loading': 'Cargando NotNativeDesktop…',
  'shell.sessions': 'Sesiones',
  'shell.newSession': 'Nueva sesión',
  'shell.send': 'Enviar',
  'shell.noSession': 'Ninguna sesión seleccionada',
  'shell.recovery.retry': 'Reintentar',
};

export const ptBR: PartialDictionary = {
  'app.title': 'NotNativeDesktop',
  'bootstrap.loading': 'Carregando NotNativeDesktop…',
  'shell.sessions': 'Sessões',
  'shell.newSession': 'Nova sessão',
  'shell.send': 'Enviar',
  'shell.noSession': 'Nenhuma sessão selecionada',
  'shell.recovery.retry': 'Tentar novamente',
};

export const ko: PartialDictionary = {
  'app.title': 'NotNativeDesktop',
  'bootstrap.loading': 'NotNativeDesktop 불러오는 중…',
  'shell.sessions': '세션',
  'shell.newSession': '새 세션',
  'shell.send': '보내기',
  'shell.noSession': '선택된 세션 없음',
  'shell.recovery.retry': '다시 시도',
};

export const pl: PartialDictionary = {
  'app.title': 'NotNativeDesktop',
  'bootstrap.loading': 'Ładowanie NotNativeDesktop…',
  'shell.sessions': 'Sesje',
  'shell.newSession': 'Nowa sesja',
  'shell.send': 'Wyślij',
  'shell.noSession': 'Nie wybrano sesji',
  'shell.recovery.retry': 'Ponów próbę',
};

export const ja: PartialDictionary = {
  'app.title': 'NotNativeDesktop',
  'bootstrap.loading': 'NotNativeDesktop を読み込み中…',
  'shell.sessions': 'セッション',
  'shell.newSession': '新しいセッション',
  'shell.send': '送信',
  'shell.noSession': 'セッション未選択',
  'shell.recovery.retry': '再試行',
};

export const tr: PartialDictionary = {
  'app.title': 'NotNativeDesktop',
  'bootstrap.loading': 'NotNativeDesktop yükleniyor…',
  'shell.sessions': 'Oturumlar',
  'shell.newSession': 'Yeni oturum',
  'shell.send': 'Gönder',
  'shell.noSession': 'Oturum seçilmedi',
  'shell.recovery.retry': 'Tekrar dene',
};

import en, { type Dictionary } from './en.ts';

const CATALOGS: Record<string, PartialDictionary> = {
  de, fr, 'zh-CN': zhCN, 'zh-TW': zhTW, uk, es, 'pt-BR': ptBR, ko, pl, ja, tr,
};

/** Full dictionaries: en complete, others merged over en per §H.2 resolve. */
export function dictionaryFor(locale: string): Dictionary {
  if (locale === 'en') return en;
  return { ...en, ...(CATALOGS[locale] ?? {}) };
}

export const PARTIAL_CATALOGS = CATALOGS;
