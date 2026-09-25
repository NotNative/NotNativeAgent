// SPDX-License-Identifier: Apache-2.0
/** Pure window-state validation and display-safe restore for the main shell. */
const MIN_WIDTH = 800;
const MIN_HEIGHT = 520;
const RESTORE_WIDTH = 900;
const RESTORE_HEIGHT = 560;

function rectangle(value) {
  return value && typeof value === 'object'
    && Number.isSafeInteger(value.x) && Number.isSafeInteger(value.y)
    && Number.isSafeInteger(value.width) && Number.isSafeInteger(value.height)
    && value.width > 0 && value.height > 0;
}

function intersection(left, right) {
  const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const height = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  return width * height;
}

function clamp(value, lower, upper) {
  return Math.max(lower, Math.min(upper, value));
}

/** `workAreas[0]` must be the primary display. Missing/offscreen geometry
 * restores onto that display; overlap selects the old display when present. */
export function restoreWindowState(saved, workAreas) {
  if (!rectangle(saved) || !Array.isArray(workAreas)) return null;
  const areas = workAreas.filter(rectangle);
  if (areas.length === 0) return null;
  let area = areas[0];
  let overlap = 0;
  for (const candidate of areas) {
    const size = intersection(saved, candidate);
    if (size > overlap) { area = candidate; overlap = size; }
  }
  const width = Math.min(Math.max(MIN_WIDTH, area.width), Math.max(RESTORE_WIDTH, saved.width));
  const height = Math.min(Math.max(MIN_HEIGHT, area.height), Math.max(RESTORE_HEIGHT, saved.height));
  const maxX = area.x + area.width - width;
  const maxY = area.y + area.height - height;
  return {
    bounds: {
      x: maxX < area.x ? area.x : clamp(saved.x, area.x, maxX),
      y: maxY < area.y ? area.y : clamp(saved.y, area.y, maxY),
      width, height,
    },
    maximized: saved.maximized === true && saved.fullscreen !== true,
    fullscreen: saved.fullscreen === true,
  };
}

export function captureWindowState(normalBounds, maximized, fullscreen) {
  if (!rectangle(normalBounds)) return null;
  return {
    x: normalBounds.x, y: normalBounds.y,
    width: Math.max(MIN_WIDTH, normalBounds.width),
    height: Math.max(MIN_HEIGHT, normalBounds.height),
    maximized: maximized === true && fullscreen !== true,
    fullscreen: fullscreen === true,
  };
}
