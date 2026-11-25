// Konsistenzprüfung eines Snapshots: Bar ohne Level, Level ohne Bar, Summen ungleich → DataInconsistency
// (nie ein 500); readTx wiederholt sie mit neuem Snapshot und meldet danach 503.
import { describe, expect, it } from 'vitest';
import { checkProfile, checkTile } from '../src/consistency.ts';
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
