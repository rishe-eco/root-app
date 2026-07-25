import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

const src = (p: string) => fileURLToPath(new URL(`./src/${p}`, import.meta.url));

export default defineConfig(() => {
  const demo = process.env.VITE_DEMO === '1';

  return {
    plugins: [react()],
    resolve: {
      alias: {
        // Outside a demo build the in-memory API is swapped for a pass-through,
        // so its placeholder contract data never reaches a real bundle.
        ...(demo ? {} : { './demoLink': src('lib/demoLink.noop.ts') }),
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    server: {
      port: demo ? 5174 : 5173,
      proxy: {
        // The API runs standalone on 4000; proxying keeps the browser
        // same-origin so the httpOnly session cookie works in development.
        '/graphql': 'http://localhost:4000',
      },
    },
  };
});
