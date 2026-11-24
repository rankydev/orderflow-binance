import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { fixtureApi } from './dev/fixture-api.ts';

// Entwicklung/Vorschau:
//  - Standard: die Fixture-API (dev/fixture-api.ts) bedient /api/v1 am Dev- und Preview-Server
//    (configureServer/configurePreviewServer); sie gelangt nie in den Build.
//  - API_PROXY=http://127.0.0.1:8780: stattdessen /api an die echte API weiterreichen (gleicher
//    Ursprung wie in Produktion hinter nginx; keine Fixtures).
// Der Build (`vite build`) ist statisch und spricht /api/v1 am eigenen Ursprung an;
// VITE_API_BASE überschreibt die Basis nur bei Bedarf (z. B. API auf anderem Host, dann CORS).
const apiProxy = process.env.API_PROXY;
const proxy = apiProxy ? { '/api': { target: apiProxy, changeOrigin: false } } : undefined;

export default defineConfig({
  plugins: [
    svelte(),
    ...(apiProxy
      ? []
      : [
          fixtureApi({
            dir: process.env.FIXTURE_DIR ?? fileURLToPath(new URL('./fixtures', import.meta.url)),
            latencyMs: Number(process.env.FIXTURE_LATENCY_MS ?? 0),
          }),
        ]),
  ],
  server: { host: '127.0.0.1', port: 5173, ...(proxy ? { proxy } : {}) },
  preview: { host: '127.0.0.1', port: 4173, ...(proxy ? { proxy } : {}) },
});
