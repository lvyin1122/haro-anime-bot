import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '0.0.0.0',
    port: 7803,
    // Fail loudly rather than drifting to 7804: the compose port mapping and
    // the URL the bootstrap script prints both assume this exact port.
    strictPort: true,
    // In dev the SPA runs on :7803 and the API on :7802; in production the
    // same Hono process serves both, so /api is origin-relative either way.
    proxy: {
      '/api': {
        target: process.env.API_TARGET ?? 'http://127.0.0.1:7802',
        changeOrigin: true
      }
    }
  },
  worker: {
    // JASSUB constructs its libass worker as a module. Vite's default `iife`
    // worker format cannot be code-split, which fails the production build.
    format: 'es'
  },
  build: {
    outDir: 'dist',
    // A Pi has limited RAM; skip the extra compression pass over the bundle.
    reportCompressedSize: false,
    chunkSizeWarningLimit: 900
  }
});
