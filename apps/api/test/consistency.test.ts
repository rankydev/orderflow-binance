// Konsistenzprüfung eines Snapshots: Bar ohne Level, Level ohne Bar, Summen ungleich → DataInconsistency
// (nie ein 500); readTx wiederholt sie mit neuem Snapshot und meldet danach 503.
import { describe, expect, it } from 'vitest';
import { checkCoverage, checkProfile, checkTile } from '../src/consistency.ts';
import { DataInconsistency, readTx, type Sql } from '../src/db.ts';
import { HttpError } from '../src/errors.ts';

const bars = (time: number[], q: number[]) => ({
  time,
  open: time.map(() => 1),
  high: time.map(() => 1),
  low: time.map(() => 1),
  close: time.map(() => 1),
  buyQ: q,
  sellQ: q.map(() => 0),
  buyA: q.map(() => 1),
  sellA: q.map(() => 0),
});
const lv = (time: number[], q: number[]) => ({
  time,
  row: time.map(() => 1),
  buy: q,
  sell: q.map(() => 0),
  buyA: q.map(() => 1),
  sellA: q.map(() => 0),
});

describe('checkTile / checkProfile', () => {
  it('erkennt Bar ohne Level, Level ohne Bar und ungleiche Summen', () => {
    expect(() => checkTile(bars([60, 120], [5, 6]), lv([60, 120], [5, 6]), true, {})).not.toThrow();
    expect(() => checkTile(bars([60, 120], [5, 6]), lv([60], [5]), false, {})).toThrow(
      /Bar t=120 ohne Level/,
    );
    expect(() => checkTile(bars([60], [5]), lv([60, 120], [5, 6]), false, {})).toThrow(/ohne Bar/);
    expect(() => checkTile(bars([60], [5]), lv([30, 60], [1, 5]), false, {})).toThrow(/ohne Bar/);
    try {
      checkTile(bars([60], [5]), lv([60], [4]), true, { sym: 'X' });
    } catch (e) {
      expect(e).toBeInstanceOf(DataInconsistency);
      expect((e as DataInconsistency).immutable).toBe(true);
      expect((e as DataInconsistency).detail).toEqual({ sym: 'X' });
    }
    const pb = [{ day: 1, low: 1, high: 2, buyQ: 3, sellQ: 4, notional: 0n }];
    expect(() => checkProfile(pb, [{ day: 1, row: 1, buy: 3, sell: 4 }], false, {})).not.toThrow();
    expect(() => checkProfile(pb, [{ day: 1, row: 1, buy: 2, sell: 4 }], false, {})).toThrow(
      /Summen/,
    );
    expect(() => checkProfile(pb, [{ day: 2, row: 1, buy: 3, sell: 4 }], false, {})).toThrow();
  });

  it('readTx: Wiederholung mit neuem Snapshot, danach 503 (Art inconsistent, Ursache angehängt)', async () => {
    let calls = 0;
    const sql = {
      begin: async (_mode: string, fn: (tx: unknown) => Promise<unknown>) => fn({}),
    } as unknown as Sql;
    const ok = await readTx(
      sql,
      { signal: new AbortController().signal, lockRetries: 0, backoffMs: 1 },
      async () => {
        if (++calls < 3) throw new DataInconsistency('Bar ohne Level', false);
        return 'fertig';
      },
    );
    expect([ok.value, calls]).toEqual(['fertig', 3]);
    const err = await readTx(
      sql,
      { signal: new AbortController().signal, lockRetries: 0, backoffMs: 1 },
      async () => {
        throw new DataInconsistency('Bar ohne Level', true);
      },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(503);
    expect((err as HttpError).kind).toBe('inconsistent');
    expect((err as { cause: DataInconsistency }).cause.immutable).toBe(true);
  });
});

describe('checkCoverage (leerer Ausschnitt, obwohl gespeicherte Minuten ihn belegen)', () => {
  const D = 86_400_000;
  const H = 3_600_000;
  /** Minuten je Stunde: `filled` Stunden ab 0 mit 60 Minuten, danach 0 (Loch bis Tagesende). */
  const hoursUntil = (filled: number) =>
    Int16Array.from({ length: 24 }, (_, h) => (h < filled ? 60 : 0));
  it('halb gefüllter Tag: leere Fenster im Loch sind gültig, auch 8 h; im gefüllten Teil nicht', () => {
    const day = () => hoursUntil(6); // Daten 00:00–06:00, danach nichts (wie der Live-Tag)
    for (const [a, b] of [
      [7 * H, 8 * H],
      [7 * H, 11 * H],
      [8 * H, 16 * H],
      [6 * H, D],
    ])
      expect(() => checkCoverage([], a!, b!, day, false, {})).not.toThrow();
    expect(() => checkCoverage([], 1 * H, 5 * H, day, true, {})).toThrow(/leer/);
    // Teilstunde am Rand allein ist kein Beleg (nur voll überdeckte Stunden zählen)
    expect(() =>
      checkCoverage([], 5 * H + 30 * 60_000, 6 * H + 30 * 60_000, day, true, {}),
    ).not.toThrow();
  });
  it('unveränderlicher Tag mit echtem mehrstündigem Loch bleibt gültig; Tag ohne Statistik: keine Prüfung', () => {
    const hole = () => Int16Array.from({ length: 24 }, (_, h) => (h >= 5 && h < 9 ? 0 : 58));
    expect(() => checkCoverage([], 5 * H, 9 * H, hole, true, {})).not.toThrow();
    expect(() => checkCoverage([], 4 * H, 9 * H, hole, true, {})).toThrow(/leer/);
    expect(() => checkCoverage([], 0, D, () => undefined, true, {})).not.toThrow();
  });
  it('über Mitternacht: jedes Tagesstück für sich; whole = der ganze Zeitraum', () => {
    const hours = (d: number) => (d === 0 ? hoursUntil(24) : hoursUntil(0)); // Tag 1 ohne Daten
    // Bar nur am ersten Tag, zweites Stück ohne Belege → gültig
    expect(() => checkCoverage([22 * H], 20 * H, D + 4 * H, hours, true, {})).not.toThrow();
    // Bars nur im (leeren) zweiten Stück, erstes Stück belegt → ungültig
    expect(() => checkCoverage([D + H], 20 * H, D + 4 * H, hours, true, {})).toThrow(/leer/);
    expect(() => checkCoverage([D + H], 20 * H, D + 4 * H, hours, true, {}, true)).not.toThrow();
  });
});

describe('readTx: Deadlock, Serialisierung, Shared Memory', () => {
  it('40P01/40001 → Wiederholung, danach 503; 53200 → sofort 503 + Retry-After 5', async () => {
    const sql = {
      begin: async (_m: string, fn: (tx: unknown) => Promise<unknown>) => fn({}),
    } as unknown as Sql;
    const opt = { signal: new AbortController().signal, lockRetries: 0, backoffMs: 1 };
    for (const code of ['40P01', '40001']) {
      let n = 0;
      const ok = await readTx(sql, opt, async () => {
        if (++n < 3) throw Object.assign(new Error(code), { code });
        return 'ok';
      });
      expect([ok.value, n]).toEqual(['ok', 3]);
      const err = await readTx(sql, opt, async () => {
        throw Object.assign(new Error(code), { code });
      }).catch((e: unknown) => e);
      expect([(err as HttpError).status, (err as HttpError).retryAfter]).toEqual([503, 2]);
    }
    let n = 0;
    const err = await readTx(sql, opt, async () => {
      n++;
      throw Object.assign(new Error('out of shared memory'), { code: '53200' });
    }).catch((e: unknown) => e);
    expect([(err as HttpError).status, (err as HttpError).retryAfter, n]).toEqual([503, 5, 1]);
  });
});
