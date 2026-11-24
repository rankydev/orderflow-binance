// Symbol-Metadaten und Einheiten (KONZEPT §3.2). Festgelegt bei Aufnahme eines Symbols; eine Zeile
// in der Tabelle `symbol` entspricht genau einem Eintrag hier (der Importer legt sie an bzw. prüft sie).

export interface SymbolSpec {
  symId: number;
  name: string;
  /** Nachkommastellen von price_unit (BTC 2 → 0,01; ETH 3 → 0,001); eine Dekade feiner als der Tick. */
  priceDecimals: number;
  /** Referenz-Tick in price_unit (BTC 10 = 0,1 $; ETH 10 = 0,01 $). Zeilen/Bins werden in Ticks angegeben. */
  tickRefUnits: number;
  /** Nachkommastellen von qty_unit (BTC/ETH 3 → 0,001). */
  qtyDecimals: number;
  /** Datenbeginn (UTC-Tag, YYYY-MM-DD). */
  dataFrom: string;
}

export const SYMBOLS: readonly SymbolSpec[] = [
  {
    symId: 1,
    name: 'BTCUSDT',
    priceDecimals: 2,
    tickRefUnits: 10,
    qtyDecimals: 3,
    dataFrom: '2025-01-01',
  },
  {
    symId: 2,
    name: 'ETHUSDT',
    priceDecimals: 3,
    tickRefUnits: 10,
    qtyDecimals: 3,
    dataFrom: '2025-01-01',
  },
];

export function getSymbol(name: string): SymbolSpec {
  const s = SYMBOLS.find((x) => x.name === name);
  if (!s)
    throw new Error(
      `Unbekanntes Symbol "${name}" (bekannt: ${SYMBOLS.map((x) => x.name).join(', ')})`,
    );
  return s;
}

/** Dezimalstring einer Einheit 10^-d, z. B. 2 → "0.01" (für die Tabelle `symbol`). */
export function unitString(decimals: number): string {
  return decimals === 0 ? '1' : `0.${'0'.repeat(decimals - 1)}1`;
}
