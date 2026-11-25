// Antwort-Cache im Prozess (KONZEPT §5.4): LRU nach Bytes, vorkomprimiert (gzip) gespeichert. Der
// Schlüssel enthält die Datenversion (Versionen aller überdeckten Tage, fehlende Tage als „-"); ein
// Treffer ist damit die Antwort, die eine neue Berechnung auf demselben Datenstand liefern würde.
// Nicht finale Antworten liegen ebenfalls im Cache, aber nur kurz (expiresAt): so fängt der Cache den
// Ansturm auf den laufenden Tag ab, und Daten, die sich künftig ohne Versionssprung ändern könnten
// (Live-Minuten ab P2), veralten höchstens um diese Frist.

export interface CachedResponse {
  body: Buffer;
  gzip: Buffer | null;
  type: string;
  etag: string;
  /** true → Browser darf eine Woche cachen (TILE-FORMAT.md), sonst no-cache. */
  final: boolean;
  /** Ablaufzeit (ms, Date.now()) für nicht finale Einträge; null = nur LRU. */
  expiresAt?: number | null;
  /**
   * HTTP-Status, falls nicht 200: gecachte Ablehnung (422 einer Ausreißer-Kachel). Wird ohne ETag
   * und mit `no-store` ausgeliefert; der Schlüssel enthält trotzdem die dataVersion.
   */
  status?: number;
}

export class ResponseCache {
  /** Finale Einträge (LRU) und nicht finale (eigene LRU, mit Ablaufzeit und Byte-Anteil). */
  private readonly fin = new Map<string, CachedResponse>();
  private readonly tmp = new Map<string, CachedResponse>();
  private finBytes = 0;
  private tmpBytes = 0;
  private lastSweep = 0;
  readonly maxBytes: number;
  /** Höchstanteil nicht finaler Einträge am Cache (Review: sie verdrängen nie die finalen). */
  readonly nonFinalShare: number;
  hits = 0;
  misses = 0;

  constructor(maxBytes: number, nonFinalShare = 0.25) {
    this.maxBytes = maxBytes;
    this.nonFinalShare = nonFinalShare;
  }

  private static size(e: CachedResponse): number {
    return e.body.length + (e.gzip?.length ?? 0) + 128;
  }

  private static expired(e: CachedResponse, now: number): boolean {
    return e.expiresAt != null && e.expiresAt <= now;
  }

  private drop(m: Map<string, CachedResponse>, key: string, e: CachedResponse): void {
    m.delete(key);
    if (m === this.fin) this.finBytes -= ResponseCache.size(e);
    else this.tmpBytes -= ResponseCache.size(e);
  }

  get(key: string): CachedResponse | undefined {
    for (const m of [this.fin, this.tmp]) {
      const e = m.get(key);
      if (!e) continue;
      if (ResponseCache.expired(e, Date.now())) {
        this.drop(m, key, e);
        break;
      }
      // LRU: ans Ende verschieben
      m.delete(key);
      m.set(key, e);
      this.hits++;
      return e;
    }
    this.misses++;
    return undefined;
  }

  /** Nur für Tests/Diagnose. */
  has(key: string): boolean {
    return this.fin.has(key) || this.tmp.has(key);
  }

  /** Entfernt abgelaufene nicht finale Einträge (höchstens einmal je Sekunde vollständig). */
  sweep(now = Date.now(), force = false): void {
    if (!force && now - this.lastSweep < 1_000) return;
    this.lastSweep = now;
    for (const [k, v] of this.tmp) if (ResponseCache.expired(v, now)) this.drop(this.tmp, k, v);
  }

  /**
   * Feste Aufteilung (Review W-1 Pass 3): nicht finale Einträge haben einen eigenen Bereich
   * (nonFinalShare · maxBytes), finale den Rest. Jeder Bereich verdrängt nur seine eigenen ältesten
   * Einträge – ein Cache voller finaler Kacheln lässt also immer Platz für den laufenden Tag.
   */
  set(key: string, e: CachedResponse): void {
    const sz = ResponseCache.size(e);
    for (const m of [this.fin, this.tmp]) {
      const old = m.get(key);
      if (old) this.drop(m, key, old);
    }
    this.sweep();
    const temporary = e.expiresAt != null;
    const tmpBudget = this.maxBytes * this.nonFinalShare;
    const finBudget = this.maxBytes - tmpBudget;
    const m = temporary ? this.tmp : this.fin;
    const budget = temporary ? tmpBudget : finBudget;
    if (sz > budget / 4) return; // einzelne Riesenantworten verdrängen nicht den ganzen Bereich
    m.set(key, e);
    if (temporary) this.tmpBytes += sz;
    else this.finBytes += sz;
    for (const [k, v] of m) {
      if ((temporary ? this.tmpBytes : this.finBytes) <= budget) break;
      this.drop(m, k, v);
    }
  }

  stats(): {
    entries: number;
    bytes: number;
    nonFinalEntries: number;
    nonFinalBytes: number;
    maxBytes: number;
    hits: number;
    misses: number;
  } {
    return {
      entries: this.fin.size + this.tmp.size,
      bytes: this.finBytes + this.tmpBytes,
      nonFinalEntries: this.tmp.size,
      nonFinalBytes: this.tmpBytes,
      maxBytes: this.maxBytes,
      hits: this.hits,
      misses: this.misses,
    };
  }
}
