// Geordneter aggTrade-Strom je Symbol (KONZEPT §4.2): führt WebSocket- und REST-Nachrichten
// zusammen, verwirft Duplikate (aggId ≤ zuletzt ausgegeben), puffert vorauseilende Nachrichten und
// gibt nur lückenlose Folgen (a = last + 1) aus. Eine Lücke ist offen, solange der Puffer Nachrichten
// mit größerer ID als die erwartete enthält; nur REST (fromId = erwartet) schließt sie. Rein, ohne I/O.
import type { AggTrade } from '@orderflow/core';

export interface FeedItem {
  trade: AggTrade;
  /** Zeile im Vision-CSV-Format (für die Spool, aus den Originalstrings). */
  line: string;
  viaRest: boolean;
}

export interface FeedStats {
  emitted: number;
  duplicates: number;
  buffered: number;
  /** Erkannte Sprünge (Nachricht mit a > erwartet). */
  jumps: number;
  /** Beweisbar nicht existierende IDs (REST lieferte als erste ID > erwartet). */
  provenMissing: number;
}

export class SymbolFeed {
  /** Nächste erwartete aggId (null = noch unbekannt, die erste Nachricht setzt sie). */
  expected: number | null;
  lastT = 0;
  private readonly buffer = new Map<number, FeedItem>();
  readonly stats: FeedStats = {
    emitted: 0,
    duplicates: 0,
    buffered: 0,
    jumps: 0,
    provenMissing: 0,
  };

  constructor(expected: number | null) {
    this.expected = expected;
  }

  /** Nimmt Nachrichten (beliebige Reihenfolge, auch doppelt) und liefert die lückenlose Folge. */
  push(items: readonly FeedItem[]): FeedItem[] {
    for (const it of items) {
      const a = it.trade.a;
      if (this.expected !== null && a < this.expected) {
        this.stats.duplicates++;
        continue;
      }
      if (this.buffer.has(a)) {
        // dieselbe ID aus WS und REST: REST-Herkunft gewinnt nicht; erste Kopie bleibt
        this.stats.duplicates++;
        continue;
      }
      if (this.expected !== null && a > this.expected && this.buffer.size === 0) this.stats.jumps++;
      this.buffer.set(a, it);
    }
    if (this.expected === null && this.buffer.size > 0) {
      this.expected = Math.min(...this.buffer.keys());
    }
    const out: FeedItem[] = [];
    if (this.expected === null) return out;
    for (;;) {
      const it = this.buffer.get(this.expected);
      if (!it) break;
      this.buffer.delete(this.expected);
      out.push(it);
      this.lastT = Math.max(this.lastT, it.trade.T);
      this.expected++;
    }
    this.stats.emitted += out.length;
    this.stats.buffered = this.buffer.size;
    return out;
  }

  /** Lücke offen: es liegen Nachrichten hinter einer fehlenden ID. */
  gapOpen(): boolean {
    return this.buffer.size > 0;
  }

  /** Erste gepufferte Nachricht (der erste Trade nach der Lücke) oder null. */
  firstBuffered(): FeedItem | null {
    const id = this.bufferedFrom();
    return id === null ? null : this.buffer.get(id)!;
  }

  /** Kleinste gepufferte ID (Ende der Lücke) oder null. */
  bufferedFrom(): number | null {
    let m: number | null = null;
    for (const k of this.buffer.keys()) if (m === null || k < m) m = k;
    return m;
  }

  /**
   * REST hat ab `expected` als erste ID `first` > expected geliefert: die IDs dazwischen existieren
   * nicht (bewiesen, §4.2). Erwartung vorziehen.
   */
  skipProvenMissing(first: number): void {
    if (this.expected !== null && first > this.expected) {
      this.stats.provenMissing += first - this.expected;
      this.expected = first;
    }
  }

  /**
   * Erwartete ID auf `id` setzen (Anfang des heutigen Tages, wenn der Rest der Lücke außerhalb des
   * REST-Fensters liegt); liefert die übersprungene Spanne.
   */
  jumpTo(id: number): { from: number; to: number } | null {
    if (this.expected === null || id <= this.expected) return null;
    const r = { from: this.expected, to: id - 1 };
    this.expected = id;
    // gepufferte Nachrichten vor dem Ziel werden nie mehr ausgegeben: verwerfen, sonst bliebe die
    // Lücke für immer „offen" (gapOpen)
    for (const k of [...this.buffer.keys()]) if (k < id) this.buffer.delete(k);
    this.stats.buffered = this.buffer.size;
    return r;
  }

  /** Lücke ist per REST nicht füllbar (älter als 48 h): auf die erste gepufferte ID springen. */
  abandonGap(): { from: number; to: number } | null {
    const to = this.bufferedFrom();
    if (to === null || this.expected === null) return null;
    const r = { from: this.expected, to: to - 1 };
    this.expected = to;
    return r;
  }
}
