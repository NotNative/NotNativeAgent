// SPDX-License-Identifier: Apache-2.0
const { parseSettingsDocument } = await import('../packages/ui/src/lib/settings/parse.ts');
const out = parseSettingsDocument({ surface: 'web', chatRenderMode: 'live', fontSize: 110, hasDesktopUiPassword: false, themeVariant: 'dark', legacyUnknownKey: 'x' });
console.log('parsed:', JSON.stringify(out));
