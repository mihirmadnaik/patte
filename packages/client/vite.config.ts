import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Straight to core's source: one build step fewer, and the client can
      // never run against a stale copy of the engine.
      '@patte/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
    },
  },
  server: {
    // Pinned, not incidental: the README and the play-from-your-phone
    // instructions both name this port, and a LAN URL that changes on every
    // restart is no use to anyone holding a phone. `strictPort` makes a
    // clash fail loudly rather than silently moving the game somewhere else.
    port: 5173,
    strictPort: true,
    // Bind all interfaces so the table can be opened from a phone on the
    // same network, and so a second identity can be tested from another host.
    host: true,
    proxy: {
      '/api': 'http://127.0.0.1:8787',
      '/ws': { target: 'ws://127.0.0.1:8787', ws: true },
    },
  },
});
