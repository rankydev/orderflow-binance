// URL-Form der API (KONZEPT §5.5). Die Entwicklungs-Fixtures (dev/fixture-api.ts) bedienen dieselben
// Pfade; die echte API ist nur eine andere Basis-URL (VITE_API_BASE, Standard: gleicher Ursprung).
import type { SymbolsResponse } from './types.ts';

/** Version der /symbols-Form, die diese Seite versteht (Feld `schema` der Antwort). */
export const SUPPORTED_SYMBOLS_SCHEMA = 2;
export const SERVER_MISMATCH = 'Server-Stand passt nicht zur Seite – Seite und Server neu laden';

/**
 * Prüft die /symbols-Antwort auf die Form, die der Client voraussetzt (A). Liefert die Probleme;
 * leer = verträglich. Unverträglich heißt: kein Footprint, sichtbare Meldung statt stiller Kerzen.
 */
export function checkSymbolsResponse(x: unknown): string[] {
  const p: string[] = [];
  const o = x as Partial<SymbolsResponse> & { schema?: unknown };
  if (typeof x !== 'object' || x === null) return ['Antwort ist kein Objekt'];
  if (o.schema !== SUPPORTED_SYMBOLS_SCHEMA)
    p.push(`schema ${String(o.schema)} ≠ ${SUPPORTED_SYMBOLS_SCHEMA}`);
  if (!Array.isArray(o.symbols) || o.symbols.length === 0) return [...p, 'keine Symbole'];
  for (const s of o.symbols) {
    const name = typeof s?.name === 'string' ? s.name : '?';
    for (const k of [
      'priceDecimals',
      'qtyDecimals',
      'tickRefUnits',
      'tickUnits',
      'dataFrom',
      'dataTo',
      'tileConfigVersion',
    ] as const) {
      if (!Number.isSafeInteger(s?.[k])) p.push(`${name}: ${k} fehlt/ungültig`);
    }
    if (typeof s?.tiles !== 'object' || s.tiles === null) {
      p.push(`${name}: tiles fehlt`);
      continue;
    }
    for (const [tf, m] of Object.entries(s.tiles)) {
      for (const [R, n] of Object.entries(m ?? {})) {
        const ok = Number.isSafeInteger(n) && n >= 32 && n <= 1024 && (n & (n - 1)) === 0;
        if (!ok || !/^[1-9]\d*$/.test(R))
          p.push(`${name}: tiles[${tf}][${R}] = ${String(n)} ungültig`);
      }
    }
  }
  return p;
}

export class IncompatibleServerError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`${SERVER_MISMATCH} (${problems.slice(0, 3).join('; ')})`);
    this.name = 'IncompatibleServerError';
    this.problems = problems;
  }
}

export class ApiClient {
  readonly base: string;
  constructor(base: string = import.meta.env.VITE_API_BASE ?? '') {
    this.base = base;
  }

  symbolsUrl(): string {
    return `${this.base}/api/v1/symbols`;
  }

  barsUrl(sym: string, tf: string, fromMs: number, toMs: number): string {
    return `${this.base}/api/v1/bars?sym=${encodeURIComponent(sym)}&tf=${tf}&from=${fromMs}&to=${toMs}`;
  }

  /** cfg = tileConfigVersion (K2): ändert sich n, ändert sich die URL (kein veralteter Cache-Treffer). */
  footprintUrl(sym: string, tf: string, R: number, tile: number, cfg: number): string {
    return `${this.base}/api/v1/footprint?sym=${encodeURIComponent(sym)}&tf=${tf}&R=${R}&tile=${tile}&cfg=${cfg}`;
  }

  async symbols(signal?: AbortSignal): Promise<SymbolsResponse> {
    const res = await fetch(this.symbolsUrl(), signal ? { signal } : {});
    if (!res.ok) throw new Error(`symbols: HTTP ${res.status} ${await res.text()}`);
    const body: unknown = await res.json();
    const problems = checkSymbolsResponse(body);
    if (problems.length > 0) throw new IncompatibleServerError(problems);
    return body as SymbolsResponse;
  }
}
