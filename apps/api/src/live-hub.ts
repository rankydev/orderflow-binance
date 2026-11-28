// Live-Verteiler (KONZEPT §5.7, Etappe 1): genau eine Upstream-Verbindung zum Recorder
// (OF_API_RECORDER_LIVE_URL, SSE GET /live), Zustand je Symbol aus snap + Deltas (LiveBook,
// @orderflow/core wire.ts), Verteilung an Browser über GET /api/v1/live?sym=… (SSE). Keine Datenbank.
//
//  - Neuer Client: sofort ein snap aus dem Zustand des Verteilers, danach jede Nachricht mit der
//    eigenen, lückenlosen Folgenummer des Verteilers (je Symbol). Upstream-Folgenummern prüft der
//    Verteiler selbst: ein Sprung → Upstream neu verbinden (neue snaps, die er weiterreicht).
//  - Einmal serialisieren, an alle Clients des Symbols schreiben. Wer mehr als maxBuffer Bytes puffert
//    (liest nicht), wird getrennt. Höchstens maxClients gleichzeitig (darüber 503).
//  - Keepalive-Kommentar alle keepaliveMs (≤ 15 s; nginx proxy_read_timeout 75 s).
//  - Upstream weg: Clients bekommen status {recorder: false} und alle statusEveryMs erneut (Herzschlag).
//  - Stummer Upstream (Verbindung offen, aber keine Bytes – z. B. hängender Recorder, halb offene
//    TCP-Verbindung): nach idleMs (5 s; die Tap sendet ≥ 1 tick/s je Symbol) abbrechen → wie Ausfall.
import type { ServerResponse } from 'node:http';
import {
  LIVE_WIRE_VERSION,
  LiveBook,
  parseLiveMsg,
  type LiveMsg,
  type StatusMsg,
} from '@orderflow/core';

export const LIVE_CLIENT_MAX_BUFFER = 256 * 1024;
export const LIVE_KEEPALIVE_MS = 15_000;
export const LIVE_STATUS_EVERY_MS = 5_000;
/** Ohne ein Byte vom Upstream so lange (ms) → Verbindung gilt als tot. */
export const LIVE_UPSTREAM_IDLE_MS = 5_000;
/** Größte erwartete Nachricht des Recorders (snap mit 240 Minuten ≈ 45 kB) mit Reserve. */
const UPSTREAM_MAX_EVENT = 1024 * 1024;

export interface LiveHubOptions {
  url: string;
  maxClients: number;
  maxBuffer?: number;
  keepaliveMs?: number;
  statusEveryMs?: number;
  idleMs?: number;
  fetchFn?: typeof fetch;
  log?: (level: 'info' | 'warn', msg: string, obj?: Record<string, unknown>) => void;
}

export interface LiveHubStats {
  upstreamConnected: boolean;
  upstreamReconnects: number;
  upstreamMessages: number;
  upstreamGaps: number;
  upstreamInvalid: number;
  upstreamIdleAborts: number;
  lastError: string | null;
  clients: number;
  accepted: number;
  rejected: number;
  dropped: number;
  messagesOut: number;
  bytesOut: number;
}

export class LiveHub {
  readonly stats: LiveHubStats = {
    upstreamConnected: false,
    upstreamReconnects: 0,
    upstreamMessages: 0,
    upstreamGaps: 0,
    upstreamInvalid: 0,
    upstreamIdleAborts: 0,
    lastError: null,
    clients: 0,
    accepted: 0,
    rejected: 0,
    dropped: 0,
    messagesOut: 0,
    bytesOut: 0,
  };
  private readonly o: Required<Omit<LiveHubOptions, 'log'>> & Pick<LiveHubOptions, 'log'>;
  private readonly books = new Map<string, LiveBook>();
  private readonly outSeq = new Map<string, number>();
  private readonly clients = new Map<string, Set<ServerResponse>>();
  private readonly ac = new AbortController();
  private conn: AbortController | null = null;
  private loop: Promise<void> | null = null;
  private keepalive: ReturnType<typeof setInterval> | null = null;
  private lastInvalidLog = 0;
  private statusTimer: ReturnType<typeof setInterval> | null = null;

  constructor(o: LiveHubOptions) {
    this.o = {
      maxBuffer: LIVE_CLIENT_MAX_BUFFER,
      keepaliveMs: LIVE_KEEPALIVE_MS,
      statusEveryMs: LIVE_STATUS_EVERY_MS,
      idleMs: LIVE_UPSTREAM_IDLE_MS,
      fetchFn: (u, i) => fetch(u, i),
      ...o,
    };
  }

  start(): void {
    this.keepalive ??= setInterval(() => this.writeAllClients(': k\n\n'), this.o.keepaliveMs);
    this.keepalive.unref();
    this.statusTimer ??= setInterval(() => {
      if (!this.stats.upstreamConnected) this.broadcastDown();
    }, this.o.statusEveryMs);
    this.statusTimer.unref();
    this.loop ??= this.run();
  }

  /** Alle Clients beenden (vor dem Schließen des Servers, sonst wartete app.close auf sie). */
  closeClients(): void {
    for (const set of this.clients.values()) for (const c of set) c.end();
    this.clients.clear();
    this.stats.clients = 0;
  }

  async stop(): Promise<void> {
    this.ac.abort();
    if (this.keepalive) clearInterval(this.keepalive);
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.keepalive = this.statusTimer = null;
    this.closeClients();
    await this.loop?.catch(() => {});
  }

  get size(): number {
    let n = 0;
    for (const s of this.clients.values()) n += s.size;
    return n;
  }

  get full(): boolean {
    return this.size >= this.o.maxClients;
  }

  /** Symbol bekannt (Upstream hat dafür schon einen Zustand geliefert)? */
  knows(sym: string): boolean {
    return this.books.has(sym);
  }

  /**
   * Client übernehmen (nach reply.hijack()): Kopfzeilen, sofort snap, dann alle Nachrichten. `headers`:
   * schon gesetzte Kopfzeilen der Anfrage (CORS, nosniff).
   */
  attach(sym: string, res: ServerResponse, headers: Record<string, unknown> = {}): boolean {
    res.on('error', () => this.remove(sym, res));
    if (this.full) {
      this.stats.rejected++;
      res.writeHead(503, { 'content-type': 'text/plain', 'retry-after': '10' });
      res.end('zu viele Live-Verbindungen\n');
      return false;
    }
    const h: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers))
      if (typeof v === 'string' || typeof v === 'number') h[k.toLowerCase()] = String(v);
    res.writeHead(200, {
      ...h,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
      'x-content-type-options': 'nosniff',
      connection: 'keep-alive',
    });
    const book = this.book(sym);
    const snap = book.snapshot(this.outSeq.get(sym) ?? 0);
    res.write(`data: ${JSON.stringify(snap)}\n\n`);
    let set = this.clients.get(sym);
    if (!set) this.clients.set(sym, (set = new Set()));
    set.add(res);
    this.stats.accepted++;
    this.stats.clients = this.size;
    res.on('close', () => this.remove(sym, res));
    return true;
  }

  private remove(sym: string, res: ServerResponse): void {
    this.clients.get(sym)?.delete(res);
    this.stats.clients = this.size;
  }

  private book(sym: string): LiveBook {
    let b = this.books.get(sym);
    if (!b) this.books.set(sym, (b = new LiveBook(sym)));
    return b;
  }

  private nextSeq(sym: string): number {
    const n = (this.outSeq.get(sym) ?? 0) + 1;
    this.outSeq.set(sym, n);
    return n;
  }

  /**
   * Eine Upstream-Nachricht (öffentlich für Tests). Liefert false bei einem Folgenummernsprung oder
   * fehlendem snap → der Aufrufer verbindet den Upstream neu.
   */
  onUpstream(m: LiveMsg): boolean {
    this.stats.upstreamMessages++;
    const book = this.book(m.sym);
    const r = book.apply(m);
    if (r === 'duplicate') return true;
    if (r === 'gap' || r === 'nosnap') {
      this.stats.upstreamGaps++;
      return false;
    }
    if (r === 'invalid') {
      this.stats.upstreamInvalid++;
      return true;
    }
    const seq = this.nextSeq(m.sym);
    const out: LiveMsg = m.t === 'snap' ? book.snapshot(seq) : { ...m, seq };
    this.broadcast(m.sym, out);
    return true;
  }

  /** Upstream nicht erreichbar: allen Symbolen status {recorder: false}. */
  upstreamDown(): void {
    this.stats.upstreamConnected = false;
    this.broadcastDown();
  }

  private broadcastDown(): void {
    for (const [sym, book] of this.books) {
      book.status = { ...book.status, recorder: false };
      const msg: StatusMsg = {
        v: LIVE_WIRE_VERSION,
        t: 'status',
        sym,
        seq: this.nextSeq(sym),
        serverMs: book.serverMs,
        status: { ...book.status },
      };
      this.broadcast(sym, msg);
    }
    // Clients eines Symbols ohne Zustand (Upstream nie erreicht) bekommen beim Verbinden den snap
  }

  private broadcast(sym: string, m: LiveMsg): void {
    const set = this.clients.get(sym);
    if (!set || set.size === 0) return;
    const s = `data: ${JSON.stringify(m)}\n\n`;
    for (const c of set) this.write(sym, c, s);
  }

  private write(sym: string, c: ServerResponse, s: string): void {
    // Gegendruck: ein Client, der nicht liest, puffert sonst unbegrenzt im Prozess
    if (c.writableLength > this.o.maxBuffer) {
      this.remove(sym, c);
      this.stats.dropped++;
      c.destroy();
      return;
    }
    c.write(s);
    this.stats.messagesOut++;
    this.stats.bytesOut += s.length;
  }

  private writeAllClients(s: string): void {
    for (const [sym, set] of this.clients) for (const c of set) this.write(sym, c, s);
  }

  private async run(): Promise<void> {
    let delay = 1_000;
    while (!this.ac.signal.aborted) {
      const conn = new AbortController();
      this.conn = conn;
      const abort = () => conn.abort();
      this.ac.signal.addEventListener('abort', abort, { once: true });
      try {
        const res = await this.o.fetchFn(this.o.url, {
          signal: conn.signal,
          headers: { accept: 'text/event-stream' },
        });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        this.stats.upstreamConnected = true;
        this.stats.lastError = null;
        this.o.log?.('info', 'live upstream connected', { url: this.o.url });
        const since = Date.now();
        try {
          await this.consume(res.body, conn);
        } finally {
          if (Date.now() - since >= 30_000) delay = 1_000;
        }
        throw new Error('Upstream beendet');
      } catch (e) {
        if (this.ac.signal.aborted) return;
        this.stats.lastError = e instanceof Error ? e.message : String(e);
        this.stats.upstreamReconnects++;
        if (this.stats.upstreamConnected)
          this.o.log?.('warn', 'live upstream lost', { error: this.stats.lastError });
        this.upstreamDown();
        await new Promise<void>((r) => {
          const t = setTimeout(r, delay);
          t.unref();
          this.ac.signal.addEventListener('abort', () => (clearTimeout(t), r()), { once: true });
        });
        delay = Math.min(30_000, delay * 2);
      } finally {
        this.ac.signal.removeEventListener('abort', abort);
        conn.abort();
      }
    }
  }

  private async consume(body: ReadableStream<Uint8Array>, conn: AbortController): Promise<void> {
    const dec = new TextDecoder();
    let buf = '';
    let lastByte = Date.now();
    let idle = false;
    const watch = setInterval(
      () => {
        if (Date.now() - lastByte > this.o.idleMs) {
          idle = true;
          conn.abort();
        }
      },
      Math.max(50, Math.floor(this.o.idleMs / 5)),
    );
    watch.unref();
    try {
      for await (const chunk of body) {
        lastByte = Date.now();
        buf += dec.decode(chunk, { stream: true }).replace(/\r\n?/g, '\n');
        for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (!this.dispatch(block)) {
            conn.abort();
            throw new Error('Folgenummer des Upstreams gesprungen');
          }
        }
        if (buf.length > UPSTREAM_MAX_EVENT) throw new Error('Upstream-Nachricht zu lang');
      }
    } catch (e) {
      if (idle) {
        this.stats.upstreamIdleAborts++;
        throw new Error(`Upstream stumm (> ${this.o.idleMs} ms ohne Daten)`, { cause: e });
      }
      throw e;
    } finally {
      clearInterval(watch);
    }
  }

  /** Ein SSE-Block; nur `data:`-Zeilen zählen, Kommentare (Keepalive) werden ignoriert. */
  private dispatch(block: string): boolean {
    let data = '';
    for (const line of block.split('\n')) if (line.startsWith('data:')) data += line.slice(5);
    if (!data) return true;
    let v: unknown;
    try {
      v = JSON.parse(data);
    } catch {
      this.stats.upstreamInvalid++;
      return true;
    }
    const m = parseLiveMsg(v);
    if (!m) {
      this.stats.upstreamInvalid++;
      // unbekannte Formatversion (Recorder neuer als die API): sichtbar machen, gedrosselt
      const ver = (v as { v?: unknown } | null)?.v;
      const now = Date.now();
      if (now - this.lastInvalidLog > 60_000) {
        this.lastInvalidLog = now;
        this.o.log?.(
          'warn',
          ver !== LIVE_WIRE_VERSION
            ? 'live upstream: unbekannte Formatversion, Nachrichten verworfen'
            : 'live upstream: ungültige Nachricht verworfen',
          { version: ver, expected: LIVE_WIRE_VERSION, invalid: this.stats.upstreamInvalid },
        );
      }
      return true;
    }
    return this.onUpstream(m);
  }
}
