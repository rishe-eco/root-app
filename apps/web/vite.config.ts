import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig(() => {
  // Proxying keeps the browser same-origin, so the httpOnly session cookie
  // works. Configurable because the e2e run starts its own API on another port
  // against a throwaway database — the default is the ordinary dev API.
  const api = process.env.VITE_API_PROXY ?? 'http://localhost:4000';

  // `/files` and `/upload` are on the API too, and they matter here for the
  // same reason /graphql does: a design image is served with the session
  // cookie attached, so it has to look same-origin to the browser. In
  // production host Nginx routes these three the same way — without them here,
  // every design image would 404 in development and work on the server, which
  // is the worst direction for that difference to run.
  // '/ask' (R4) is the same same-origin-cookie story, plus one more thing:
  // it's a streamed SSE response, so it must never be buffered — Vite's
  // proxy passes chunks through as they arrive by default, which is exactly
  // what a reader watching an answer stream in needs.
  const proxy = { '/graphql': api, '/files': api, '/upload': api, '/ask': api };

  return {
    plugins: [react()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    server: { port: 5173, proxy },
    // `vite preview` serves the built output, which is what e2e drives — the
    // dev server's transform pipeline is not what ships.
    preview: { port: Number(process.env.PREVIEW_PORT ?? 4173), proxy },
  };
});
