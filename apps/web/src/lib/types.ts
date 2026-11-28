// Gemeinsame Typen des Frontends. Chartdaten selbst liegen in Typed Arrays außerhalb der Svelte-
// Reaktivität (KONZEPT §7.3); hier nur Formen und UI-Einstellungen.

import type { UTCTimestamp } from 'lightweight-charts';

/** P1-Typen (KONZEPT §6.1): Delta (Default) und Bid×Ask. Volume, Delta+Volume folgen in P4. */
export type FootprintType = 'delta' | 'bidask' | 'volume' | 'deltavol';
/** Darstellung der Zellen (§6.1): Box = Zahl in gefärbter Zelle, Profil = Balken je Zeile ∝ Wert / Max im Bar. */
export type FootprintMode = 'box' | 'profile';
/** Farbmodi v1 (KONZEPT §6.1): aus, fest, Verlauf. */
export type ColorMode = 'off' | 'fixed' | 'gradient';
/** Bereich der Farbreferenz (KONZEPT §6.1): sichtbare Bars (Default) oder je Bar. */
export type ColorScope = 'visible' | 'bar';
/** Level of Detail (KONZEPT §7.2): 3 Zahlen, 2 Zellen, 1 Kerzen. */
export type Lod = 1 | 2 | 3;

/** Antwort von GET /api/v1/symbols (Form der Fixture-API; die echte API liefert dieselben Felder). */
export interface SymbolInfo {
  name: string;
  priceDecimals: number;
  qtyDecimals: number;
  tickRefUnits: number;
  /** Aktueller Tick in price_unit (R ≥ Tick, KONZEPT §3.2). */
  tickUnits: number;
  /** Datenbereich [dataFrom, dataTo) in ms. */
  dataFrom: number;
  dataTo: number;
  tileConfigVersion: number;
  /** Kachellänge n je tf und R (Ticks); fehlende R sind für diesen tf nicht zulässig (Zellgrenze). */
  tiles: Record<string, Record<string, number>>;
  /**
   * Big Trades (docs/BIGTRADES-API.md): Untergrenze der gespeicherten Orders; null/fehlt = für dieses
   * Symbol nicht verfügbar. minUsdt = kleinste zulässige Schwelle in ganzen USDT.
   */
  bigTrades?: { floorN: number; minUsdt: number; notionalDecimals: number } | null;
}

export interface SymbolsResponse {
  symbols: SymbolInfo[];
  /** Grenzen der Endpunkte (seit API 60f6264; optional) */
  limits?: {
    profile?: { maxRows: number; maxR: number; maxRangeDays: number };
    tiles?: { statsColumns?: string[] };
    bigtrades?: {
      maxBars: number;
      maxRows: number;
      maxSourceRows: number;
      maxMatchedRows: number;
      maxMinUsdt: number;
    };
  };
}

/** Datenitem beider Serien (Kerzen + Footprint); Preise als Gleitkomma für die Bibliothek, Ganzzahlen für Zeilen. */
export interface BarItem {
  /** Bar-Beginn in Sekunden (UTC). */
  time: UTCTimestamp;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Bar-Beginn in Sekunden; Kopie von time, weil die Bibliothek `time` aus originalData entfernt. */
  t: number;
  /** Ganzzahlige Preise in price_unit. */
  o: number;
  h: number;
  l: number;
  /** buyQ + sellQ in Lots (Querprüfung gegen Footprint-Kacheln). */
  v: number;
  c: number;
  /** buyQ, sellQ (Lots), buyA, sellA (aggTrades) – Stats-Grid */
  b: number;
  s: number;
  ba: number;
  sa: number;
  /** Zusatzspalten `x.*` der Bar-Kachel je Bar (falls die API sie liefert) */
  x?: Record<string, number>;
  /** Bucket enthält vorläufige Live-Minuten (live.ts); nur im Tooltip gekennzeichnet */
  live?: boolean;
}
