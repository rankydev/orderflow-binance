// Platzhalter-Einstiegspunkt (recorder, geplant für Phase P2). Noch keine Logik.
export const APP_NAME = 'recorder';
export const PLANNED_PHASE = 'P2';

export function main(): number {
  console.error(`${APP_NAME}: noch nicht implementiert (geplant in Phase ${PLANNED_PHASE})`);
  return 2;
}

if (import.meta.main) {
  process.exitCode = main();
}
