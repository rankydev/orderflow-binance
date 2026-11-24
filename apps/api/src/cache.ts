// Antwort-Cache im Prozess (KONZEPT §5.4): LRU nach Bytes, nur für unveränderliche Antworten
// (final = true), vorkomprimiert (gzip) gespeichert. Schlüssel enthält die Datenversion; ein Treffer
// ist damit genau die Antwort, die eine neue Berechnung auf demselben Datenstand liefern würde.

export interface CachedResponse {
  body: Buffer;
  gzip: Buffer | null;
  type: string;
  etag: string;
  /** true → Cache-Control immutable (nur unveränderliche Daten gelangen in den Cache). */
  final: boolean;
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
    if (!e) {
      this.misses++;
      return undefined;
    }
    // LRU: ans Ende verschieben
    this.map.delete(key);
    this.map.set(key, e);
    this.hits++;
    return e;
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
