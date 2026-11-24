// Platzhalter-Einstiegspunkt (api, geplant für Phase P1). Noch keine Logik.
export const APP_NAME = 'api';
export const PLANNED_PHASE = 'P1';

export function main(): number {
  console.error(`${APP_NAME}: noch nicht implementiert (geplant in Phase ${PLANNED_PHASE})`);
  return 2;
}

if (import.meta.main) {
  process.exitCode = main();
}
