// URL-Form der API (KONZEPT §5.5). Die Entwicklungs-Fixtures (dev/fixture-api.ts) bedienen dieselben
// Pfade; die echte API ist nur eine andere Basis-URL (VITE_API_BASE, Standard: gleicher Ursprung).
import type { SymbolsResponse } from './types.ts';

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

  footprintUrl(sym: string, tf: string, R: number, tile: number): string {
    return `${this.base}/api/v1/footprint?sym=${encodeURIComponent(sym)}&tf=${tf}&R=${R}&tile=${tile}`;
  }

  async symbols(signal?: AbortSignal): Promise<SymbolsResponse> {
    const res = await fetch(this.symbolsUrl(), signal ? { signal } : {});
    if (!res.ok) throw new Error(`symbols: HTTP ${res.status} ${await res.text()}`);
    return (await res.json()) as SymbolsResponse;
  }
}
