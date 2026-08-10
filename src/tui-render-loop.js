// SPDX-License-Identifier: Apache-2.0

export function createRenderLoop(output, capabilities, screen, renderer, projection, onError) {
  let timer = null;
  let animationTimer = null;
  let animationFrame = 0;
  let closed = false;
  let lastRenderMs = 0;
  const now = () => {
    if (closed) return;
    if (timer) { clearTimeout(timer); timer = null; }
    try {
      const started = performance.now();
      screen.paint(renderer.frame(projection, {
        ...capabilities, width: output.columns ?? capabilities.width, height: output.rows ?? capabilities.height,
        animationFrame,
      }));
      lastRenderMs = Math.max(0, performance.now() - started);
      syncAnimation();
    } catch (error) { onError(error); }
  };
  const syncAnimation = () => {
    const shouldAnimate = projection.active?.()?.activeTurnId && capabilities.reducedMotion !== true;
    if (!shouldAnimate) { clearTimeout(animationTimer); animationTimer = null; return; }
    if (animationTimer) return;
    animationTimer = setTimeout(() => {
      animationTimer = null;
      animationFrame += 1;
      now();
    }, 120);
  };
  return {
    now,
    schedule() {
      if (closed || timer) return;
      timer = setTimeout(now, adaptiveRenderDelay(lastRenderMs, capabilities.reducedMotion));
    },
    invalidate() { if (!closed) screen.invalidate(); },
    cancel() {
      closed = true;
      clearTimeout(timer); clearTimeout(animationTimer);
      timer = null; animationTimer = null;
    },
  };
}

export function adaptiveRenderDelay(lastRenderMs, reducedMotion = false) {
  const base = reducedMotion ? 50 : 33;
  return !Number.isFinite(lastRenderMs) || lastRenderMs <= 0
    ? base : Math.max(base, Math.min(200, Math.ceil(lastRenderMs * 2)));
}
