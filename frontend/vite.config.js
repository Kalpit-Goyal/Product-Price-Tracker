import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The dev server proxies to the local backend so the browser sees one origin.
    // This is only a convenience: in production the frontend calls the Render URL
    // directly via VITE_API_BASE_URL, because a public Vercel page cannot rely on
    // a proxy existing in front of it.
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
