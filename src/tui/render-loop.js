// SPDX-License-Identifier: Apache-2.0

export function createRenderLoop(output, capabilities, screen, renderer, projection, onError) {
  const terminalOutput = output ?? {};
  const renderingCapabilities = capabilities ?? {};
  let timer = null;
  let animationTimer = null;
  let animationFrame = 0;
  let closed = false;
  let lastRenderMs;
  const now = () => {
    if (closed) return;
    if (timer) { clearTimeout(timer); timer = null; }
    try {
      const started = performance.now();
      screen.paint(renderer.frame(projection, {
        ...renderingCapabilities,
        width: terminalOutput.columns ?? renderingCapabilities.width,
        height: terminalOutput.rows ?? renderingCapabilities.height,
        animationFrame,
      }));
      lastRenderMs = Math.max(0, performance.now() - started);
      syncAnimation();
    } catch (error) {
      try { onError?.(error); } catch { /* Error reporting must not recursively crash rendering. */ }
    }
  };
  const syncAnimation = () => {
    const activeTurn = projection?.active?.()?.activeTurnId;
    if (!activeTurn) { clearTimeout(animationTimer); animationTimer = null; return; }
    if (animationTimer) return; // Coalesce invalidations into the already scheduled animation frame.
    animationTimer = setTimeout(() => {
      animationTimer = null;
      if (capabilities.reducedMotion !== true) animationFrame += 1;
      now();
    }, renderingCapabilities.reducedMotion === true ? 1_000 : 50);
  };
  return {
    now,
    schedule() {
      if (closed || timer) return;
      timer = setTimeout(now, adaptiveRenderDelay(lastRenderMs, renderingCapabilities.reducedMotion));
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
