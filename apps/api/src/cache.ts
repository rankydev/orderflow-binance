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
}

export class ResponseCache {
  private readonly map = new Map<string, CachedResponse>();
  private bytes = 0;
  readonly maxBytes: number;
  hits = 0;
  misses = 0;

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes;
  }

  private static size(e: CachedResponse): number {
    return e.body.length + (e.gzip?.length ?? 0) + 128;
  }

  get(key: string): CachedResponse | undefined {
    const e = this.map.get(key);
    if (e && e.expiresAt != null && e.expiresAt <= Date.now()) {
      this.map.delete(key);
      this.bytes -= ResponseCache.size(e);
    } else if (e) {
      // LRU: ans Ende verschieben
      this.map.delete(key);
      this.map.set(key, e);
      this.hits++;
      return e;
    }
    this.misses++;
    return undefined;
  }

  /** Nur für Tests/Diagnose. */
  has(key: string): boolean {
    return this.map.has(key);
  }

  set(key: string, e: CachedResponse): void {
    const sz = ResponseCache.size(e);
    if (sz > this.maxBytes / 4) return; // einzelne Riesenantworten verdrängen nicht den ganzen Cache
    const old = this.map.get(key);
    if (old) {
      this.bytes -= ResponseCache.size(old);
      this.map.delete(key);
    }
    this.map.set(key, e);
    this.bytes += sz;
    for (const [k, v] of this.map) {
      if (this.bytes <= this.maxBytes) break;
      this.map.delete(k);
      this.bytes -= ResponseCache.size(v);
    }
  }

  stats(): { entries: number; bytes: number; maxBytes: number; hits: number; misses: number } {
    return {
      entries: this.map.size,
      bytes: this.bytes,
      maxBytes: this.maxBytes,
      hits: this.hits,
      misses: this.misses,
    };
  }
}
