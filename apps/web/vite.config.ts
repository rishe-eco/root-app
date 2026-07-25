import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // The API runs standalone on 4000; proxying keeps the browser same-origin
      // so the httpOnly session cookie works in development.
      '/graphql': 'http://localhost:4000',
    },
  },
});
