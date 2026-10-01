// SPDX-License-Identifier: Apache-2.0
import { bootstrapStrings, readStoredLocaleForBootstrap } from '@notnative/ui/lib/i18n/bootstrap.ts';
import { BCP47ByLocale } from '@notnative/ui/lib/i18n/runtime.ts';

export function applyStoredLocaleToSplash(documentLike: Pick<Document, 'documentElement' | 'getElementById'>): void {
  const locale = readStoredLocaleForBootstrap();
  if (locale === null) return;
  documentLike.documentElement.lang = BCP47ByLocale[locale];
  const loading = documentLike.getElementById('initial-loading-text');
  if (loading) loading.textContent = bootstrapStrings(locale)['bootstrap.loading'];
}
