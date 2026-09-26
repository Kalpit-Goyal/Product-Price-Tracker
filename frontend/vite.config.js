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
        // WHY THIS IS A VARIABLE. It used to be hardcoded to 127.0.0.1:3001 while the
        // backend defaults to PORT=10000, so a fresh clone could not talk to itself:
        // `npm start` in backend/ and `npm run dev` in frontend/ looked fine and
        // returned nothing. The default now matches backend/src/config.js.
        //
        // Override with BACKEND_URL when the backend runs elsewhere:
        //   $env:BACKEND_URL='http://127.0.0.1:3001'; npm run dev
        target: process.env.BACKEND_URL ?? 'http://127.0.0.1:10000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
