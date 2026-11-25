// Tägliche Finalisierungsschleife des Recorders (aus main.ts herausgelöst, testbar ohne DB).
// Je Symbol werden die Tage nach dem letzten finalen Tag bis gestern der Reihe nach versucht; ein
// Tag, der (noch) nicht geht, beendet die Reihe für dieses Symbol bis zum nächsten Durchlauf.
// Ein Fehler NACH dem Festschreiben (postCommitError) zählt als finalisiert (Review H3): der Tag ist
// in der DB final, die Folgetage werden weiter versucht, der Fehler wird getrennt gemeldet.
import { dayIndex, formatDay, type SymbolSpec } from '@orderflow/core';
import { nextAttempt, type FinaliseResult, type PostCommitError } from './finalize.ts';

export interface LoopSymbol {
  spec: SymbolSpec;
  final: { day: number } | null;
  days: Map<number, { frozen: string | null; completeBefore: number }>;
}

export interface FinaliseLoopOptions {
  now: number;
  symbols: Iterable<[string, LoopSymbol]>;
  /** letzter Versuch je `${symbol}|${day}` (wird fortgeschrieben) */
  attempts: Map<string, number>;
  everyMs?: number;
  finalise: (spec: SymbolSpec, day: number) => Promise<FinaliseResult>;
  /** Tag ist final: Zustand nachladen (markFinal), Rohdaten aufräumen … */
  afterFinal: (name: string, spec: SymbolSpec, day: number) => Promise<void>;
  onPostCommitError: (name: string, day: number, e: PostCommitError) => void;
  log: (msg: string, fields: Record<string, unknown>) => void;
}

export async function finaliseDue(o: FinaliseLoopOptions): Promise<void> {
  const today = dayIndex(o.now);
  for (const [name, s] of o.symbols) {
    const from = s.final ? s.final.day + 1 : today - 1;
    for (let d = from; d < today; d++) {
      const key = `${name}|${d}`;
      const at = nextAttempt(d, o.now, o.attempts.get(key) ?? null, o.everyMs ?? 15 * 60_000);
      if (o.now < at) break;
      // erst nach dem letzten geschriebenen Tagesende (+ Marge) des Recorders
      const di = s.days.get(d);
      if (di && !di.frozen && di.completeBefore < 1440) break;
      o.attempts.set(key, o.now);
      try {
        const r = await o.finalise(s.spec, d);
        if (r === 'not_available' || r === 'lock_busy') {
          o.log('finalise later', { symbol: name, day: formatDay(d), reason: r });
          break;
        }
        if (r !== 'done' && r.postCommitError) o.onPostCommitError(name, d, r.postCommitError);
        await o.afterFinal(name, s.spec, d);
        o.log('finalised', { symbol: name, day: formatDay(d) });
      } catch (e) {
        o.log('finalise failed', { symbol: name, day: formatDay(d), error: String(e) });
        break;
      }
    }
  }
}
