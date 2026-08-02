import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    // In dev the SPA runs on :5173 and the API on :3000; in production the
    // same Hono process serves both, so /api is origin-relative either way.
    proxy: {
      '/api': {
        target: process.env.API_TARGET ?? 'http://127.0.0.1:3000',
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: 'dist',
    // A Pi has limited RAM; skip the extra compression pass over the bundle.
    reportCompressedSize: false,
    chunkSizeWarningLimit: 900
  }
});
