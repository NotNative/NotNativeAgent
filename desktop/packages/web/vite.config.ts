import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import type { ProxyOptions } from 'vite';

const apiTarget = `http://127.0.0.1:${process.env.NOTNATIVE_HMR_API_PORT ?? '3902'}`;

/** Preserve the browser's Origin on HTTP writes. The backend sees a rewritten
 * Host, so stamp the browser-visible host from the request at this trusted
 * dev hop (overwriting any client-supplied forwarding header). WebSocket
 * upgrades keep the existing target-Origin parity needed by the WS gate. */
export function apiProxy(webSocket = false): ProxyOptions {
  return {
    target: apiTarget,
    changeOrigin: true,
    ...(webSocket ? { ws: true } : {}),
    configure(proxy) {
      proxy.on('proxyReq', (outgoing, incoming) => {
        outgoing.setHeader('x-forwarded-host', incoming.headers.host ?? '');
      });
      if (webSocket) proxy.on('proxyReqWs', (outgoing, incoming) => {
        outgoing.setHeader('x-forwarded-host', incoming.headers.host ?? '');
        outgoing.setHeader('origin', apiTarget);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: { __APP_VERSION__: JSON.stringify('0.0.1') },
  resolve: {
    alias: {
      '@notnative/ui': path.resolve(process.cwd(), '../ui/src'),
    },
  },
  server: {
    // Production HTML carries the same directive in the static handler.
    // Dev previews can redirect to this Vite origin, so keep parity here.
    headers: { 'Content-Security-Policy': "frame-ancestors 'none'" },
    proxy: {
      '/auth': apiProxy(),
      '/health': { target: apiTarget, changeOrigin: true },
      '/api': apiProxy(true),
      '/manifest.webmanifest': { target: apiTarget, changeOrigin: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx,js}'],
    // Why: 32 logical cores available; this suite is test-bound (child git
    // processes), so workers help until the spawn fan-out saturates. Why not
    // more: bounded memory per forked worker on this machine.
    maxWorkers: 12,
  },
});
