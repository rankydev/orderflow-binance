// Ereignis-Feed des Recorders (SSE auf seinem Health-Port, apps/recorder main.ts): je festgeschriebener
// Minute `event: minute` mit {symbol, ts}. Der Recorder erhöht im selben Commit data_day.version; die
// API stößt deshalb nur eine Katalog-Aktualisierung an (Catalog.poke) – die Versionen, Daten und
// Statistik kommen wie immer aus der Datenbank, das Ereignis ist nur der Zeitpunkt. Fällt der Feed
// aus, bleibt die Abfrage alle pollMs (nichts geht verloren, es dauert nur bis zur nächsten Abfrage).

/** Ab dieser Verbindungsdauer gilt der Feed auch ohne Ereignis als gesund (Backoff zurück auf 1 s). */
export const HEALTHY_CONNECTION_MS = 30_000;

export interface EventFeedStatus {
  url: string;
  connected: boolean;
  events: number;
  lastEventAt: number | null;
  reconnects: number;
  lastError: string | null;
}

export class RecorderEvents {
  readonly status: EventFeedStatus;
  private readonly onMinute: (symbol: string, ts: number) => void;
  private readonly ac = new AbortController();
  private loop: Promise<void> | null = null;

  constructor(url: string, onMinute: (symbol: string, ts: number) => void) {
    this.status = {
      url,
      connected: false,
      events: 0,
      lastEventAt: null,
      reconnects: 0,
      lastError: null,
    };
    this.onMinute = onMinute;
  }

  start(): void {
    this.loop ??= this.run();
  }

  async stop(): Promise<void> {
    this.ac.abort();
    await this.loop?.catch(() => {});
  }

  private async run(): Promise<void> {
    let delay = 1_000;
    while (!this.ac.signal.aborted) {
      try {
        const res = await fetch(this.status.url, {
          signal: this.ac.signal,
          headers: { accept: 'text/event-stream' },
        });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        this.status.connected = true;
        this.status.lastError = null;
        const since = Date.now();
        const before = this.status.events;
        try {
          await this.consume(res.body);
        } finally {
          // Backoff erst zurücksetzen, wenn die Verbindung etwas getragen hat (ein Ereignis oder
          // ≥ 30 s offen): ein Server, der annimmt und sofort schließt, bekommt sonst 1 Versuch/s
          if (this.status.events > before || Date.now() - since >= HEALTHY_CONNECTION_MS)
            delay = 1_000;
        }
        throw new Error('Feed beendet');
      } catch (e) {
        this.status.connected = false;
        if (this.ac.signal.aborted) return;
        this.status.lastError = e instanceof Error ? e.message : String(e);
        this.status.reconnects++;
        await new Promise<void>((r) => {
          const t = setTimeout(r, delay);
          t.unref();
          this.ac.signal.addEventListener('abort', () => (clearTimeout(t), r()), { once: true });
        });
        delay = Math.min(30_000, delay * 2);
      }
    }
  }

  private async consume(body: ReadableStream<Uint8Array>): Promise<void> {
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of body) {
      buf += dec.decode(chunk, { stream: true }).replace(/\r\n?/g, '\n');
      // Ereignisse sind durch eine Leerzeile getrennt; unvollständige bleiben im Puffer
      for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
        this.dispatch(buf.slice(0, i));
        buf = buf.slice(i + 2);
      }
      if (buf.length > 65_536) throw new Error('Ereignis zu lang');
    }
  }

  /**
   * Ein SSE-Ereignisblock; nur `event: minute` mit gültigen Daten zählt, alles andere wird ignoriert –
   * auch Kommentarzeilen (`: ok`, Keepalive), auf die der Client nicht angewiesen ist.
   */
  private dispatch(block: string): void {
    let event = 'message';
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (event !== 'minute') return;
    let v: unknown;
    try {
      v = JSON.parse(data);
    } catch {
      return;
    }
    const o = v as { symbol?: unknown; ts?: unknown };
    if (typeof o.symbol !== 'string' || typeof o.ts !== 'number') return;
    this.status.events++;
    this.status.lastEventAt = Date.now();
    this.onMinute(o.symbol, o.ts);
  }
}
