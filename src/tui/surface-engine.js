// SPDX-License-Identifier: Apache-2.0

const NAVIGATION_LABELS = Object.freeze({
  menu: 'Up/Down choose · Enter select',
  form: 'Type value · Enter continue · Esc previous',
  confirm: 'Up/Down choose · Enter confirm',
  detail: 'Up/Down choose · Enter select',
  scroll: 'Up/Down scroll',
  progress: 'Please wait',
});

export function createMenuOverlay(kind, title, lines, items, options = {}) {
  const activeId = options.activeId ?? options.selectedId;
  const selected = Math.max(0, items.findIndex((item) => item.id === activeId));
  const { activeId: _activeId, selectedId: _selectedId, navigation = 'menu', ...extra } = options;
  return Object.freeze({
    kind, title,
    lines: Object.freeze(lines.slice(0, 256).map(String)),
    items: Object.freeze(items.slice(0, 256).map((item) => Object.freeze({ ...item }))),
    selected, offset: 0, navigation, ...extra,
  });
}

export function createDetailOverlay(kind, title, lines, items, options = {}) {
  return createMenuOverlay(kind, title, lines, items, { navigation: 'detail', ...options });
}

export function createConfirmationOverlay(kind, title, lines, items, options = {}) {
  const safeId = options.safeId ?? items[0]?.id;
  const { safeId: _safeId, ...extra } = options;
  return createMenuOverlay(kind, title, lines, items, {
    navigation: 'confirm', activeId: safeId, ...extra,
  });
}

export function overlayControlLabel(overlay) {
  const primary = overlay.actionLabel ?? NAVIGATION_LABELS[overlay.navigation]
    ?? (overlay.items?.length ? NAVIGATION_LABELS.menu : NAVIGATION_LABELS.scroll);
  const parts = [primary];
  if (!/\bEsc\b/iu.test(primary)) parts.push('Esc back');
  if (!/Ctrl\+G/iu.test(primary) && !/Ctrl\+C/iu.test(primary)) parts.push('Ctrl+G/Ctrl+C close');
  return parts.join(' · ');
}
