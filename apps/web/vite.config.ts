import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { fixtureApi } from './dev/fixture-api.ts';

// Die Fixture-API hängt nur am Dev- und Preview-Server (configureServer/configurePreviewServer) und
// gelangt nicht in den Build. FIXTURE_LATENCY_MS simuliert Netzlatenz.
export default defineConfig({
  plugins: [
    svelte(),
    fixtureApi({
      dir: process.env.FIXTURE_DIR ?? fileURLToPath(new URL('./fixtures', import.meta.url)),
      latencyMs: Number(process.env.FIXTURE_LATENCY_MS ?? 0),
    }),
  ],
  server: { host: '127.0.0.1', port: 5173 },
  preview: { host: '127.0.0.1', port: 4173 },
});
