import { defineConfig } from 'vitest/config';

// Drei Projekte:
//  - unit: reine Tests, keine Datenbank nötig (`npm test`)
//  - db:   Integrationstests gegen die lokale Timescale-DB (`npm run test:db`)
//  - golden: Golden-Tests auf echten Binance-Dateien unter data/ (`npm run test:golden`, opt-in,
//            liest mehrere hundert MB; nur lesend)
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['{packages,apps}/*/test/**/*.test.ts'],
          exclude: ['**/*.int.test.ts', '**/*.golden.test.ts', '**/node_modules/**'],
        },
      },
      {
        test: {
          name: 'golden',
          include: ['{packages,apps}/*/test/**/*.golden.test.ts'],
          exclude: ['**/node_modules/**'],
          fileParallelism: false,
          testTimeout: 900_000,
          hookTimeout: 900_000,
        },
      },
      {
        test: {
          name: 'db',
          include: ['{packages,apps}/*/test/**/*.int.test.ts'],
          exclude: ['**/node_modules/**'],
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
