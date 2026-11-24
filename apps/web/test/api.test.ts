// A: der Client erkennt einen unverträglichen Server-Stand an /symbols (statt still Kerzen zu zeichnen).
import { describe, expect, it } from 'vitest';
import {
  checkSymbolsResponse,
  IncompatibleServerError,
  SUPPORTED_SYMBOLS_SCHEMA,
} from '../src/lib/api.ts';

const good = () => ({
  schema: SUPPORTED_SYMBOLS_SCHEMA,
  symbols: [
    {
      name: 'BTCUSDT',
      priceDecimals: 2,
      qtyDecimals: 3,
      tickRefUnits: 10,
      tickUnits: 10,
      dataFrom: 1,
      dataTo: 2,
      tileConfigVersion: 2,
      tiles: { '1m': { '5': 32, '100': 256 } },
    },
  ],
});

describe('checkSymbolsResponse', () => {
  it('akzeptiert die erwartete Form', () => {
    expect(checkSymbolsResponse(good())).toEqual([]);
  });
  it('alter Server ohne schema (beobachteter Fall: tileConfigVersion 1, alte Kachellängen) → unverträglich', () => {
    const old = good() as Record<string, unknown>;
    delete old.schema;
    expect(checkSymbolsResponse(old).join()).toMatch(/schema/);
  });
  it('fremde Form, fehlende Felder und unmögliche Kachellängen werden gemeldet', () => {
    expect(checkSymbolsResponse(null)).toEqual(['Antwort ist kein Objekt']);
    expect(checkSymbolsResponse({ schema: 2, symbols: [] })).toContain('keine Symbole');
    const g = good();
    (g.symbols[0] as Record<string, unknown>).tickRefUnits = undefined;
    g.symbols[0]!.tiles['1m']!['5'] = 48; // keine Zweierpotenz
    g.symbols[0]!.tiles['1m']!['100'] = 4096; // über 1024
    const p = checkSymbolsResponse(g).join(' | ');
    expect(p).toMatch(/tickRefUnits/);
    expect(p).toMatch(/tiles\[1m\]\[5\] = 48/);
    expect(p).toMatch(/tiles\[1m\]\[100\] = 4096/);
  });
  it('Fehlerklasse trägt eine verständliche Meldung', () => {
    const e = new IncompatibleServerError(['schema undefined ≠ 2']);
    expect(e.message).toMatch(/Server-Stand passt nicht zur Seite/);
  });
});
