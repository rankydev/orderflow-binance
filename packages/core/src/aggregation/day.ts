// Tagesaggregation (KONZEPT §3.3–§3.5): aggTrades eines UTC-Tages in aggId-Reihenfolge →
// fp_1m-Basiszeilen (1 Minute × nativer Preis), bar_1m, Kandidaten für den Kline-Abgleich (§4.6)
// und die empirische Tickweite (symbol_tick_history). Speicher: nur der Tag, nie Rohzeilen.
import type { AggTrade } from '../parser/csv.ts';
import { DAY_MS, MINUTE_MS } from '../constants.ts';
import { MINUTES_PER_DAY } from '../time.ts';
import { BarAcc, type Bar } from './bar.ts';
import { FpBuilder, type FpTable } from './fp.ts';

/** Kandidatenregel §4.6: Mehrfach-Fill und T mod 60 000 ≥ 59 900. */
export const CANDIDATE_FROM_MS = 59_900;

export function isCandidate(t: Pick<AggTrade, 'f' | 'l' | 'T'>): boolean {
  return t.l > t.f && t.T % MINUTE_MS >= CANDIDATE_FROM_MS;
}

const INT32_MAX = 2_147_483_647;

export interface DayAggregate {
  /** UTC-Tagesindex. */
  day: number;
  trades: number;
  fp1m: FpTable;
  /** bar_1m, nur Minuten mit Trades, nach ts sortiert. */
  bars: Bar[];
  /** Σ Menge der Kandidaten je Minute (Lots), für q und b (nur m = false). */
  candQ: Float64Array;
  candB: Float64Array;
  /** Anzahl Kandidaten-aggTrades des Tages. */
  candCount: number;
  /** ggT aller |px_i − px_{i−1}| des Tages (0, wenn nur ein Preis vorkam). */
  minStepUnits: number;
}

function gcd(a: number, b: number): number {
  while (b !== 0) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

export class DayAggregator {
  readonly day: number;
  private readonly dayStart: number;
  private readonly dayEnd: number;
  private cur = -1;
  private trades = 0;
  private readonly fp = new FpBuilder(1 << 16);
  private readonly bars: Bar[] = [];
  private readonly bar = new BarAcc();
  private readonly candQ = new Float64Array(MINUTES_PER_DAY);
  private readonly candB = new Float64Array(MINUTES_PER_DAY);
  private candCount = 0;
  private g = 0;
  private lastPx = -1;
  // Level der laufenden Minute
  private readonly slot = new Map<number, number>();
  private lvN = 0;
  private lvPx: number[] = [];
  private lvBQ: number[] = [];
  private lvSQ: number[] = [];
  private lvBA: number[] = [];
  private lvSA: number[] = [];
  private finished = false;

  constructor(day: number) {
    this.day = day;
    this.dayStart = day * DAY_MS;
    this.dayEnd = this.dayStart + DAY_MS;
  }

  /** aggTrades müssen in aggId-Reihenfolge kommen; T darf innerhalb des Tages nicht über eine Minutengrenze zurücklaufen. */
  add(t: AggTrade): void {
    const T = t.T;
    if (T < this.dayStart || T >= this.dayEnd) {
      throw new Error(`aggTrade ${t.a}: T=${T} liegt nicht im UTC-Tag ${this.day}`);
    }
    const minute = (T - this.dayStart - (T % MINUTE_MS)) / MINUTE_MS;
    if (minute !== this.cur) {
      if (minute < this.cur) {
        throw new Error(
          `aggTrade ${t.a}: Zeit läuft über eine Minutengrenze zurück (Minute ${minute} nach ${this.cur})`,
        );
      }
      if (this.cur >= 0) this.flushMinute();
      this.cur = minute;
    }
    let s = this.slot.get(t.px);
    if (s === undefined) {
      s = this.lvN++;
      this.slot.set(t.px, s);
      this.lvPx[s] = t.px;
      this.lvBQ[s] = 0;
      this.lvSQ[s] = 0;
      this.lvBA[s] = 0;
      this.lvSA[s] = 0;
    }
    if (t.m) {
      this.lvSQ[s]! += t.q;
      this.lvSA[s]!++;
    } else {
      this.lvBQ[s]! += t.q;
      this.lvBA[s]!++;
    }
    this.bar.add(t.a, t.px, t.q, T, t.m);
    if (t.l > t.f && T % MINUTE_MS >= CANDIDATE_FROM_MS) {
      this.candQ[minute]! += t.q;
      if (!t.m) this.candB[minute]! += t.q;
      this.candCount++;
    }
    if (this.lastPx >= 0 && t.px !== this.lastPx) {
      this.g = gcd(this.g, Math.abs(t.px - this.lastPx));
    }
    this.lastPx = t.px;
    this.trades++;
  }

  private flushMinute(): void {
    const ts = this.dayStart + this.cur * MINUTE_MS;
    const idx = new Array<number>(this.lvN);
    for (let i = 0; i < this.lvN; i++) idx[i] = i;
    const px = this.lvPx;
    idx.sort((a, b) => px[a]! - px[b]!);
    for (const i of idx) {
      const bq = this.lvBQ[i]!;
      const sq = this.lvSQ[i]!;
      if (bq > INT32_MAX || sq > INT32_MAX) {
        throw new Error(`fp_1m-Überlauf: Menge > int32 bei ts=${ts}, px=${px[i]}`);
      }
      this.fp.push(ts, px[i]!, bq, sq, this.lvBA[i]!, this.lvSA[i]!);
    }
    this.bars.push(this.bar.finish(ts));
    this.bar.reset();
    this.slot.clear();
    this.lvN = 0;
  }

  finish(): DayAggregate {
    if (this.finished) throw new Error('DayAggregator.finish zweimal aufgerufen');
    this.finished = true;
    if (this.cur >= 0) this.flushMinute();
    return {
      day: this.day,
      trades: this.trades,
      fp1m: this.fp.build(),
      bars: this.bars,
      candQ: this.candQ,
      candB: this.candB,
      candCount: this.candCount,
      minStepUnits: this.g,
    };
  }
}

/** Bequemlichkeit für Tests: aggregiert eine Liste von aggTrades (in aggId-Reihenfolge) eines Tages. */
export function aggregateDay(day: number, trades: Iterable<AggTrade>): DayAggregate {
  const agg = new DayAggregator(day);
  for (const t of trades) agg.add(t);
  return agg.finish();
}
