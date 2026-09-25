import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const apiTarget = `http://127.0.0.1:${process.env.NOTNATIVE_HMR_API_PORT ?? '3902'}`;

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
      '/auth': { target: apiTarget, changeOrigin: true },
      '/health': { target: apiTarget, changeOrigin: true },
      // §3.9/§9 parity: the dev hop rewrites Origin to the target exactly
      // like the relay loopback dialer, so the terminal WS upgrade gate's
      // host-equality rule (vs the changeOrigin-rewritten Host) keeps
      // admitting the vite client. http-proxy merges `headers` into BOTH
      // the web and ws passes (setupOutgoing), after which changeOrigin
      // fixes the Host header.
      '/api': { target: apiTarget, changeOrigin: true, ws: true, headers: { origin: apiTarget } },
      '/manifest.webmanifest': { target: apiTarget, changeOrigin: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
