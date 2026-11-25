// Ereignis-Feed /events (Server-Sent Events) für die API: „Minute M committed" (§4.2).
// Beim Verbinden sofort Kopfzeilen und ein Kommentar `: ok` (sonst sähe ein Client vor dem ersten
// Minuten-Ereignis keine Antwort und meldete „nicht verbunden"), danach alle keepaliveMs ein
// Kommentar `: keepalive` (undici bricht eine stille Antwort nach 300 s ab).
import type { IncomingMessage, ServerResponse } from 'node:http';

export const SSE_KEEPALIVE_MS = 20_000;
/** Höchstzahl gleichzeitiger Clients; weitere erhalten 503 (die API braucht einen). */
export const SSE_MAX_CLIENTS = 16;
/** Puffert ein Client mehr als so viele Bytes (liest nicht), wird er getrennt. */
export const SSE_MAX_BUFFER = 1024 * 1024;

export class EventHub {
  private readonly clients = new Set<ServerResponse>();
  private readonly timer: ReturnType<typeof setInterval>;

  /** Getrennt wegen Gegendruck (für Health/Tests). */
  dropped = 0;

  private readonly maxClients: number;
  private readonly maxBuffer: number;

  constructor(
    keepaliveMs = SSE_KEEPALIVE_MS,
    maxClients = SSE_MAX_CLIENTS,
    maxBuffer = SSE_MAX_BUFFER,
  ) {
    this.maxClients = maxClients;
    this.maxBuffer = maxBuffer;
    this.timer = setInterval(() => this.writeAll(': keepalive\n\n'), keepaliveMs);
    this.timer.unref();
  }

  get size(): number {
    return this.clients.size;
  }

  attach(req: IncomingMessage, res: ServerResponse): void {
    res.on('error', () => this.clients.delete(res)); // abgebrochene Verbindung: nie unbehandelt
    if (this.clients.size >= this.maxClients) {
      res.writeHead(503, { 'content-type': 'text/plain', 'retry-after': '10' });
      res.end('zu viele Ereignis-Clients\n');
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(': ok\n\n');
    this.clients.add(res);
    res.on('close', () => this.clients.delete(res));
  }

  minute(symbol: string, ts: number): void {
    this.writeAll(`event: minute\ndata: ${JSON.stringify({ symbol, ts })}\n\n`);
  }

  close(): void {
    clearInterval(this.timer);
    for (const c of this.clients) c.end();
    this.clients.clear();
  }

  private writeAll(s: string): void {
    for (const c of this.clients) {
      // Gegendruck: ein Client, der nicht liest, puffert sonst unbegrenzt im Prozess
      if (c.writableLength > this.maxBuffer) {
        this.clients.delete(c);
        this.dropped++;
        c.destroy();
        continue;
      }
      c.write(s);
    }
  }
}
