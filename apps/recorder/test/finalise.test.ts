// Finalisierung ohne DB: Entscheidung nach einem Fehler (H3), Schleife mit Fehler nach dem
// Festschreiben (H3a) und Beobachtung teilweise komprimierter Chunks über Neustarts (H2a).
import { DAY_MS, getSymbol, parseDay } from '@orderflow/core';
import { describe, expect, it } from 'vitest';
import { decideAfterError, type FinaliseResult } from '../src/finalize.ts';
import { finaliseDue, type LoopSymbol } from '../src/finaliseloop.ts';
import { PARTIAL_ALERT_AGE_MS, PartialChunkTracker } from '../src/partialchunks.ts';

describe('decideAfterError (H3)', () => {
  it('Erfolg nur, wenn der Tag durch diesen Lauf final wurde', () => {
    // vorher kein Eintrag, nachher final → dieser Lauf hat ihn geschrieben
    expect(decideAfterError(null, { state: 'final_ok', version: 1 })).toBe('success');
    // vorher schon final, Version unverändert → nicht von diesem Lauf
    expect(
      decideAfterError({ state: 'final_ok', version: 7 }, { state: 'final_ok', version: 7 }),
    ).toBe('throw');
    // nachher nicht final (Fehler vor dem Festschreiben, Zustand wiederhergestellt)
    expect(
      decideAfterError(
        { state: 'provisional', version: 40 },
        { state: 'provisional', version: 40 },
      ),
    ).toBe('throw');
    expect(decideAfterError(null, null)).toBe('throw');
    // nachher final mit Version + 1 → festgeschrieben, Fehler kam danach
    expect(
      decideAfterError({ state: 'provisional', version: 40 }, { state: 'final_bad', version: 41 }),
    ).toBe('success');
  });
});

describe('finaliseDue (H3a)', () => {
  it('Fehler nach dem Festschreiben: markFinal wird aufgerufen und der Folgetag versucht', async () => {
    const spec = getSymbol('BTCUSDT');
    const today = parseDay('2026-11-25');
    const s: LoopSymbol = { spec, final: { day: today - 3 }, days: new Map() };
    const calls: number[] = [];
    const finalised: number[] = [];
    const errors: [number, string][] = [];
    await finaliseDue({
      now: today * DAY_MS + 7 * 3600_000,
      symbols: [['BTCUSDT', s]],
      attempts: new Map(),
      finalise: async (_spec, day): Promise<FinaliseResult> => {
        calls.push(day);
        return day === today - 2
          ? { quality: null, postCommitError: { source: 'settle', message: 'resolveEdge kaputt' } }
          : { quality: null };
      },
      afterFinal: async (_n, _sp, day) => {
        finalised.push(day);
        s.final = { day }; // wie markFinal nach startState
      },
      onPostCommitError: (_n, day, e) => errors.push([day, e.source]),
      log: () => {},
    });
    expect(calls).toEqual([today - 2, today - 1]);
    expect(finalised).toEqual([today - 2, today - 1]);
    expect(errors).toEqual([[today - 2, 'settle']]);
    expect(s.final).toEqual({ day: today - 1 });
  });

  it('ein echter Fehler beendet die Reihe für das Symbol', async () => {
    const spec = getSymbol('BTCUSDT');
    const today = parseDay('2026-11-25');
    const s: LoopSymbol = { spec, final: { day: today - 3 }, days: new Map() };
    const calls: number[] = [];
    const logs: string[] = [];
    await finaliseDue({
      now: today * DAY_MS + 7 * 3600_000,
      symbols: [['BTCUSDT', s]],
      attempts: new Map(),
      finalise: async (_spec, day) => {
        calls.push(day);
        throw new Error('Digest-Abweichung');
      },
      afterFinal: async () => {
        throw new Error('darf nicht aufgerufen werden');
      },
      onPostCommitError: () => {},
      log: (m) => logs.push(m),
    });
    expect(calls).toEqual([today - 2]);
    expect(logs).toEqual(['finalise failed']);
  });
});

describe('PartialChunkTracker (H2a)', () => {
  const H = 3600_000;
  it('Alter übersteht einen Neustart über die gespeicherten details', () => {
    const t0 = parseDay('2026-11-20') * DAY_MS;
    const today = parseDay('2026-11-25');
    const a = new PartialChunkTracker();
    const s1 = a.update(['c1'], t0, today - 1, today);
    expect(s1).toMatchObject({ count: 1, oldestAgeMs: 0, alert: false });
    // Neustart 30 h später: neuer Prozess, Zeitpunkte aus ingest_status.details
    const b = new PartialChunkTracker();
    b.seed(s1.firstSeen);
    b.seed({ c1: t0 + 5 * H, junk: 'x' }); // zweite Statuszeile, späterer Zeitpunkt verliert
    expect(b.firstSeen()).toEqual({ c1: t0 });
    const s2 = b.update(['c1'], t0 + 30 * H, today - 1, today);
    expect(s2.oldestAgeMs).toBe(30 * H);
    expect(s2.oldestAgeMs).toBeGreaterThan(PARTIAL_ALERT_AGE_MS);
    expect(s2.alert).toBe(true);
    // nachverdichtet → vergessen
    expect(b.update([], t0 + 31 * H, today - 1, today)).toMatchObject({ count: 0, alert: false });
    expect(b.firstSeen()).toEqual({});
  });

  it('Alarm bei teilweisem Chunk, wenn die Finalisierung mehr als einen Tag zurückliegt', () => {
    const today = parseDay('2026-11-25');
    const now = today * DAY_MS + 10 * H;
    expect(new PartialChunkTracker().update(['c'], now, today - 1, today).alert).toBe(false);
    expect(new PartialChunkTracker().update(['c'], now, today - 2, today).alert).toBe(false);
    const late = new PartialChunkTracker().update(['c'], now, today - 3, today);
    expect(late.alert).toBe(true);
    expect(late.alertReason).toMatch(/Finalisierung/);
    expect(new PartialChunkTracker().update([], now, today - 9, today).alert).toBe(false);
  });
});
