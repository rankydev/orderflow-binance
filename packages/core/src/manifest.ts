// Manifest-Felder je Tag und Datei (KONZEPT §3.1). Rein: Zähler und Datentypen; das Schreiben der
// Sidecar-Dateien und der Tabellen raw_file/raw_day übernimmt der Importer.

export type RawKind = 'aggTrades' | 'klines' | 'trades';
export type Origin = 'daily' | 'monthly';

export interface DayManifest {
  symbol: string;
  kind: RawKind;
  day: string;
  origin: Origin;
  /** relativ zu data/raw/binance-vision/ */
  originPath: string;
  originSha256: string;
  rows: number;
  firstAggId: number | null;
  lastAggId: number | null;
  aggIdHoles: number;
  aggIdDups: number;
  tsBackwards: number;
  /** first_agg_id = last_agg_id(Vortag) + 1; null = Vortag unbekannt. */
  continuesPrev: boolean | null;
  firstTs: number | null;
  lastTs: number | null;
  /** Σ fehlender Trade-IDs zwischen aufeinanderfolgenden aggTrades (f − l_vorher − 1 > 0); nur Bericht. */
  tradeIdGapSum: number;
  /** Größter solcher Sprung; ein großer Wert zeigt eine Datenlücke trotz lückenloser aggIds. */
  tradeIdGapMax: number;
  /** Größter zeitlicher Abstand zwischen aufeinanderfolgenden aggTrades (ms). */
  maxTimeGapMs: number;
  headerPresent: boolean;
  downloadedAt: string | null;
  importerVersion: string;
}

export interface FileManifest {
  path: string;
  symbol: string;
  kind: RawKind;
  origin: Origin;
  /** 'YYYY-MM-DD' oder 'YYYY-MM' */
  period: string;
  bytes: number;
  sha256: string;
  checksumExpected: string;
  checksumOk: boolean;
  headerPresent: boolean;
  rows: number;
  downloadedAt: string | null;
  importerVersion: string;
  /** Monatsdatei: Tageseinträge; Tagesdatei: genau einer. */
  days: DayManifest[];
}

/** Felder, die beim Vergleich Monats- vs. Tagesdatei abweichen dürfen (Herkunft). */
export const ORIGIN_FIELDS = ['origin', 'originPath', 'originSha256', 'downloadedAt'] as const;

export function comparableDayManifest(
  d: DayManifest,
): Omit<DayManifest, (typeof ORIGIN_FIELDS)[number]> {
  const rest: Partial<DayManifest> = { ...d };
  for (const k of ORIGIN_FIELDS) delete rest[k];
  return rest as Omit<DayManifest, (typeof ORIGIN_FIELDS)[number]>;
}

/** Laufende Vollständigkeitszähler eines Tages (aggId-Kontinuität, Zeitreihenfolge). */
export class DayStats {
  rows = 0;
  firstAggId: number | null = null;
  lastAggId: number | null = null;
  holes = 0;
  dups = 0;
  tsBackwards = 0;
  firstTs: number | null = null;
  lastTs: number | null = null;
  tradeIdGapSum = 0;
  tradeIdGapMax = 0;
  maxTimeGapMs = 0;
  private lastL = -1;

  add(a: number, T: number, f = -1, l = -1): void {
    if (this.lastL >= 0 && f >= 0) {
      const g = f - this.lastL - 1;
      if (g > 0) {
        this.tradeIdGapSum += g;
        if (g > this.tradeIdGapMax) this.tradeIdGapMax = g;
      }
    }
    if (l >= 0) this.lastL = l;
    if (this.lastTs !== null && T - this.lastTs > this.maxTimeGapMs)
      this.maxTimeGapMs = T - this.lastTs;
    if (this.lastAggId !== null) {
      if (a <= this.lastAggId) this.dups++;
      else if (a > this.lastAggId + 1) this.holes += a - this.lastAggId - 1;
    } else {
      this.firstAggId = a;
      this.firstTs = T;
    }
    if (this.lastTs !== null && T < this.lastTs) this.tsBackwards++;
    if (this.lastAggId === null || a > this.lastAggId) this.lastAggId = a;
    this.lastTs = T;
    this.rows++;
  }
}
