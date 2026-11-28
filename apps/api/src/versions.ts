// Datenversion und Unveränderlichkeit einer Antwort (KONZEPT §5.4, TILE-FORMAT.md): Hash über die
// Versionen aller überdeckten (Symbol, UTC-Tag) + Antwortparameter (+ tileConfigVersion bei Kacheln).
// `final` nur, wenn jeder überdeckte Tag existiert und data_day.immutable ist (final_*, keine offene
// Randminute, nicht veraltet). Ein Tag ohne data_day-Zeile (Lücke, Zukunft, vor Datenbeginn) ist nie
// final: dort können noch Daten entstehen (Backfill, Live).
import { createHash } from 'node:crypto';

export interface DayVersion {
  day: number;
  version: number;
  immutable: boolean;
}

/** Version des Antwortaufbaus (Inhalt bei gleichem Datenstand); erhöhen trennt alle ETags. */
// 2: Quellzeilen-Schätzung (sourceRowsEstimate, X-Rows-Estimate) aus der Bar-Schranke (53af8a4) –
//    gleicher Datenstand, anderer Antwortinhalt, also neue ETags
// 3: /bars-Header mit committedTo (Live-Naht, Etappe 1) – gleicher Datenstand, anderer Inhalt
export const RESPONSE_BUILD_VERSION = 3;

export function versionOf(
  parts: (string | number)[],
  d0: number,
  d1: number,
  get: (day: number) => DayVersion | null | undefined,
  /** Zusatz je Tag für den Hash (z. B. Zahl der Lückenminuten, die ohne Versionswechsel entstehen). */
  extra?: (day: number) => string | number | undefined,
): { dataVersion: string; final: boolean } {
  const h = createHash('sha256');
  h.update(`b${RESPONSE_BUILD_VERSION}|${parts.join('|')}|${d0}..${d1}|`);
  let final = true;
  for (let d = d0; d <= d1; d++) {
    const v = get(d);
    if (!v) {
      final = false;
      h.update('-,');
    } else {
      if (!v.immutable) final = false;
      h.update(`${v.version}${v.immutable ? 'i' : 'm'},`);
    }
    if (extra) h.update(`${extra(d) ?? '-'};`);
  }
  return { dataVersion: h.digest('base64url').slice(0, 27), final };
}

/**
 * Version einer /quality-Antwort: Hash über die Parameter und die Qualitäts-Fingerabdrücke der
 * überdeckten Tage (fehlende Tage als „-"). Nie final.
 */
export function qualityVersion(
  parts: (string | number)[],
  d0: number,
  d1: number,
  fp: (day: number) => string | null | undefined,
): string {
  const h = createHash('sha256');
  h.update(`q${RESPONSE_BUILD_VERSION}|${parts.join('|')}|${d0}..${d1}|`);
  for (let d = d0; d <= d1; d++) h.update(`${fp(d) ?? '-'},`);
  return h.digest('base64url').slice(0, 27);
}
