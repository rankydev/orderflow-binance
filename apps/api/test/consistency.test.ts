// Konsistenzprüfung eines Snapshots: Bar ohne Level, Level ohne Bar, Summen ungleich → DataInconsistency
// (nie ein 500); readTx wiederholt sie mit neuem Snapshot und meldet danach 503.
import { describe, expect, it } from 'vitest';
import { checkCoverage, checkProfile, checkTile } from '../src/consistency.ts';
import { DataInconsistency, readTx, type Sql } from '../src/db.ts';
import { hasMinute, maskOf, minuteCount } from '../src/minutes.ts';
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
  const M = 60_000;
  const range = (a: number, b: number) => Array.from({ length: b - a }, (_, i) => a + i);
  /** Minuten [0, filledMin) gespeichert, danach nichts (Loch bis Tagesende). */
  const until = (filledMin: number) => maskOf(range(0, filledMin));
  it('halb gefüllter Tag: leere Fenster im Loch sind gültig, auch 8 h; im gefüllten Teil nicht', () => {
    const day = () => until(6 * 60); // Daten 00:00–06:00, danach nichts (wie der Live-Tag)
    for (const [a, b] of [
      [7 * H, 8 * H],
      [7 * H, 11 * H],
      [8 * H, 16 * H],
      [6 * H, D],
      [6 * H, 6 * H + 15 * M],
    ])
      expect(() => checkCoverage([], a!, b!, day, false, {})).not.toThrow();
    expect(() => checkCoverage([], 1 * H, 5 * H, day, true, {})).toThrow(/leer/);
    // über den Rand: die gespeicherten Minuten 05:30–05:59 liegen im Fenster → ohne Bar ungültig
    expect(() => checkCoverage([], 5 * H + 30 * M, 6 * H + 30 * M, day, true, {})).toThrow(/leer/);
    expect(() =>
      checkCoverage([5 * H + 30 * M], 5 * H + 30 * M, 6 * H + 30 * M, day, true, {}),
    ).not.toThrow();
  });
  it('Fenster unter einer Stunde: 15 min mit gespeicherten Minuten, ohne Bar → ungültig', () => {
    // nur die Minuten 10:20–10:24 gespeichert (z. B. ein ruhiger Markt)
    const sparse = () => maskOf(range(10 * 60 + 20, 10 * 60 + 25));
    expect(() => checkCoverage([], 10 * H + 15 * M, 10 * H + 30 * M, sparse, true, {})).toThrow(
      /Minute .*T10:20/,
    );
    expect(() =>
      checkCoverage([10 * H + 15 * M], 10 * H + 15 * M, 10 * H + 30 * M, sparse, true, {}),
    ).not.toThrow();
    // Fenster direkt daneben (keine gespeicherte Minute darin) → gültig leer
    expect(() =>
      checkCoverage([], 10 * H + 25 * M, 10 * H + 40 * M, sparse, true, {}),
    ).not.toThrow();
    expect(() => checkCoverage([], 10 * H, 10 * H + 20 * M, sparse, true, {})).not.toThrow();
    // ein einzelnes 1-Minuten-Fenster
    expect(() => checkCoverage([], 10 * H + 24 * M, 10 * H + 25 * M, sparse, true, {})).toThrow();
    expect(() =>
      checkCoverage([], 10 * H + 25 * M, 10 * H + 26 * M, sparse, true, {}),
    ).not.toThrow();
  });
  it('unveränderlicher Tag mit echtem mehrstündigem Loch bleibt gültig; Tag ohne Statistik: keine Prüfung', () => {
    const hole = () => maskOf([...range(0, 5 * 60), ...range(9 * 60, 1440)]);
    expect(() => checkCoverage([], 5 * H, 9 * H, hole, true, {})).not.toThrow();
    expect(() => checkCoverage([], 4 * H, 9 * H, hole, true, {})).toThrow(/leer/);
    expect(() => checkCoverage([], 0, D, () => undefined, true, {})).not.toThrow();
  });
  it('über Mitternacht: jedes Tagesstück für sich; whole = der ganze Zeitraum', () => {
    const mins = (d: number) => (d === 0 ? until(1440) : until(0)); // Tag 1 ohne Daten
    // Bar nur am ersten Tag, zweites Stück ohne Belege → gültig
    expect(() => checkCoverage([22 * H], 20 * H, D + 4 * H, mins, true, {})).not.toThrow();
    // Bars nur im (leeren) zweiten Stück, erstes Stück belegt → ungültig
    expect(() => checkCoverage([D + H], 20 * H, D + 4 * H, mins, true, {})).toThrow(/leer/);
    expect(() => checkCoverage([D + H], 20 * H, D + 4 * H, mins, true, {}, true)).not.toThrow();
  });
  it('Minutenmaske: Bits, Zählung, Grenzen', () => {
    const m = maskOf([0, 29, 30, 59, 60, 1439]);
    expect([0, 29, 30, 59, 60, 1439].every((x) => hasMinute(m, x))).toBe(true);
    expect([1, 28, 31, 61, 1438].some((x) => hasMinute(m, x))).toBe(false);
    expect(minuteCount(m)).toBe(6);
    expect(minuteCount(maskOf(range(0, 1440)))).toBe(1440);
    expect(Math.max(...maskOf(range(0, 1440)))).toBe(2 ** 30 - 1);
    expect(() => maskOf([1440])).toThrow();
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
