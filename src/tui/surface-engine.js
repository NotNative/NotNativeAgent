// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';

const NAVIGATION_LABELS = Object.freeze({
  menu: 'Up/Down choose · Enter select',
  form: 'Type value · Enter continue · Esc previous',
  confirm: 'Up/Down choose · Enter confirm',
  detail: 'Up/Down choose · Enter select',
  scroll: 'Up/Down scroll',
  progress: 'Please wait',
});

export function createMenuOverlay(kind, title, lines, items, options = {}) {
  validateMenu(lines, items, options);
  items = items.slice(0, 256);
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
  validateMenu(lines, items, options);
  const safeId = options.safeId;
  if (typeof safeId !== 'string' || !items.slice(0, 256).some((item) => item.id === safeId)) {
    throw new ContractError('tui_surface_invalid', 'confirmation requires a retained safe choice');
  }
  const { safeId: _safeId, ...extra } = options;
  return createMenuOverlay(kind, title, lines, items, {
    ...extra, navigation: 'confirm', activeId: safeId,
  });
}

function validateMenu(lines, items, options) {
  if (!Array.isArray(lines) || !Array.isArray(items) || !options || typeof options !== 'object'
    || Array.isArray(options) || items.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) {
    throw new ContractError('tui_surface_invalid', 'menu requires line and item arrays with an options object');
  }
}

export function overlayControlLabel(overlay) {
  const primary = overlay.actionLabel ?? NAVIGATION_LABELS[overlay.navigation]
    ?? (overlay.items?.length ? NAVIGATION_LABELS.menu : NAVIGATION_LABELS.scroll);
  const parts = [primary];
  if (!/\bEsc\b/iu.test(primary)) parts.push('Esc back');
  if (!/Ctrl\+G/iu.test(primary) && !/Ctrl\+C/iu.test(primary)) parts.push('Ctrl+G/Ctrl+C close');
  return parts.join(' · ');
}
