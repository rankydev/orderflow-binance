// Teilweise komprimierte Chunks beobachten (Review H2, H2a). Seit Migration 0014 verdichtet nur ein
// schreibender Importer-Lauf sie unter Sperre nach; ein lange bestehender teilweiser Chunk ist
// lesbar, zeigt aber, dass das Nachverdichten nicht gelingt. Der Katalog führt keinen Zeitpunkt,
// daher merkt sich der Recorder „zuerst gesehen" je Chunk und schreibt es nach ingest_status.details
// (partialChunkFirstSeen), damit das Alter Neustarts (Watchdog bei Binance-Ausfall) übersteht.

// Seit Migration 0015 liegen offene Chunks nie im Columnstore; ein teilweise komprimierter Chunk
// entsteht nur noch kurz, wenn ein kalter Tag ersetzt wird (Finalisierung nach langem Ausfall,
// erzwungener Re-Import), und derselbe Lauf verdichtet ihn unter Sperre nach. Eine Stunde ist
// daher schon ungewöhnlich.
export const PARTIAL_ALERT_AGE_MS = 3600_000;

export interface PartialChunkState {
  count: number;
  /** offene Chunks (range_end > now() - of_hot_margin()) im Columnstore: darf es nie geben (0015) */
  hotCompressed: number;
  oldestAgeMs: number;
  firstSeen: Record<string, number>;
  alert: boolean;
  alertReason: string | null;
}

export class PartialChunkTracker {
  private seen = new Map<string, number>();

  /** Persistierte Zeitpunkte übernehmen (frühester gewinnt; mehrere Statuszeilen je Symbol). */
  seed(firstSeen: Record<string, unknown> | null | undefined): void {
    for (const [c, t] of Object.entries(firstSeen ?? {})) {
      if (typeof t !== 'number' || !Number.isFinite(t)) continue;
      const cur = this.seen.get(c);
      if (cur === undefined || t < cur) this.seen.set(c, t);
    }
  }

  /** Bekannte Zeitpunkte (auch vor der ersten Prüfung: die übernommenen). */
  firstSeen(): Record<string, number> {
    return Object.fromEntries(this.seen);
  }

  /**
   * Aktuelle Liste übernehmen. `lastFinalDay`/`today`: Tagesindizes; ein teilweiser Chunk, während
   * die Finalisierung mehr als einen Tag zurückliegt (letzter finaler Tag < heute − 2), ist ebenfalls
   * ein Alarm – dann läuft auch kein Importer, der ihn nachverdichten würde.
   */
  update(
    current: string[],
    now: number,
    lastFinalDay: number | null,
    today: number,
    hotCompressed: string[] = [],
  ): PartialChunkState {
    const cur = new Set(current);
    for (const k of [...this.seen.keys()]) if (!cur.has(k)) this.seen.delete(k);
    for (const c of cur) if (!this.seen.has(c)) this.seen.set(c, now);
    const oldest = this.seen.size ? Math.min(...this.seen.values()) : now;
    const oldestAgeMs = now - oldest;
    let alertReason: string | null = null;
    if (hotCompressed.length > 0)
      alertReason = `offene Chunks im Columnstore: ${hotCompressed.join(', ')} (repair-open-chunks)`;
    else if (cur.size > 0 && oldestAgeMs > PARTIAL_ALERT_AGE_MS)
      alertReason = `teilweise komprimierter Chunk seit ${Math.round(oldestAgeMs / 3600_000)} h`;
    else if (cur.size > 0 && (lastFinalDay === null || lastFinalDay < today - 2))
      alertReason = 'teilweise komprimierte Chunks, Finalisierung liegt mehr als einen Tag zurück';
    return {
      count: cur.size,
      hotCompressed: hotCompressed.length,
      oldestAgeMs,
      firstSeen: Object.fromEntries(this.seen),
      alert: alertReason !== null,
      alertReason,
    };
  }
}
