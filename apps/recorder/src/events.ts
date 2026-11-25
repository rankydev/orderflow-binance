// Ereignis-Feed /events (Server-Sent Events) für die API: „Minute M committed" (§4.2).
// Beim Verbinden sofort Kopfzeilen und ein Kommentar `: ok` (sonst sähe ein Client vor dem ersten
// Minuten-Ereignis keine Antwort und meldete „nicht verbunden"), danach alle keepaliveMs ein
// Kommentar `: keepalive` (undici bricht eine stille Antwort nach 300 s ab).
import type { IncomingMessage, ServerResponse } from 'node:http';

export const SSE_KEEPALIVE_MS = 20_000;

export class EventHub {
  private readonly clients = new Set<ServerResponse>();
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(keepaliveMs = SSE_KEEPALIVE_MS) {
    this.timer = setInterval(() => this.writeAll(': keepalive\n\n'), keepaliveMs);
    this.timer.unref();
  }

  get size(): number {
    return this.clients.size;
  }

  attach(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(': ok\n\n');
    this.clients.add(res);
    req.on('close', () => this.clients.delete(res));
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
    for (const c of this.clients) c.write(s);
  }
}
