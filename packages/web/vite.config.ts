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
    proxy: {
      '/auth': { target: apiTarget, changeOrigin: true },
      '/health': { target: apiTarget, changeOrigin: true },
      '/api': { target: apiTarget, changeOrigin: true, ws: true },
      '/manifest.webmanifest': { target: apiTarget, changeOrigin: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
