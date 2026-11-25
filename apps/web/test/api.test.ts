// A: der Client erkennt einen unverträglichen Server-Stand an /symbols (statt still Kerzen zu zeichnen).
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiClient,
  checkSymbolsResponse,
  IncompatibleServerError,
  NoDataError,
  SUPPORTED_SYMBOLS_SCHEMA,
  timeoutSignal,
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

describe('Produktion: Fehlertexte, leere Daten, Zeitgrenze', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('HTTP-Fehler: Anzeige nur mit Status, kein Antworttext (nginx-Seite)', async () => {
    vi.stubGlobal(
      'fetch',
      async () => new Response('<html>nginx/1.24.0 Too Many Requests</html>', { status: 429 }),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(new ApiClient('').symbols()).rejects.toThrow(/^symbols: HTTP 429$/);
    warn.mockRestore();
  });
  it('leere Symbolliste → „Noch keine Daten vorhanden" (kein Versionsbanner)', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ schema: 2, symbols: [] })));
    await expect(new ApiClient('').symbols()).rejects.toBeInstanceOf(NoDataError);
    await expect(new ApiClient('').symbols()).rejects.toThrow('Noch keine Daten vorhanden');
  });
  it('timeoutSignal funktioniert auch ohne AbortSignal.timeout (ältere Browser)', async () => {
    const orig = AbortSignal.timeout;
    (AbortSignal as unknown as { timeout?: unknown }).timeout = undefined;
    try {
      const s = timeoutSignal(5);
      expect(s.aborted).toBe(false);
      await new Promise((r) => setTimeout(r, 20));
      expect(s.aborted).toBe(true);
    } finally {
      AbortSignal.timeout = orig;
    }
  });
});
