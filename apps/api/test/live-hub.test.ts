// Live-Verteiler (Etappe 1): eine Upstream-Verbindung, eigene lückenlose Folgenummern, snap beim
// Verbinden, langsamer Client wird getrennt, Clientgrenze, Upstream-Ausfall → status recorder: false,
// Folgenummernsprung des Upstreams → Neuverbindung; Route /api/v1/live (SSE-Kopfzeilen, 404/503).
import {
  LIVE_WIRE_VERSION,
  LiveBook,
  MINUTE_MS,
  parseLiveMsg,
  STATUS_UNKNOWN,
  type LiveBar,
  type LiveMsg,
  type TickMsg,
} from '@orderflow/core';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { parseApiConfig } from '../src/config.ts';
import type { Deps } from '../src/context.ts';
import { LiveHub } from '../src/live-hub.ts';

const T0 = Date.UTC(2026, 10, 25, 12);
const bar = (ts: number, close: number): LiveBar => ({
  ts,
  open: close,
  high: close,
  low: close,
  close,
  buyQ: 1,
  sellQ: 2,
  buyA: 1,
  sellA: 1,
  firstAgg: close,
  lastAgg: close,
});
const base = { v: LIVE_WIRE_VERSION, sym: 'BTCUSDT', serverMs: T0 };
const snap = (seq: number, bars: LiveBar[] = []): LiveMsg => ({
  ...base,
  t: 'snap',
  seq,
  committedTo: T0,
  from: T0 - 10 * MINUTE_MS,
  price: null,
  eventMs: T0,
  bars,
  status: { ...STATUS_UNKNOWN, recorder: true, stream: true },
});
const tick = (seq: number, close: number): TickMsg => ({
  ...base,
  t: 'tick',
  seq,
  price: close,
  eventMs: T0,
  bars: [bar(T0, close)],
});
const sse = (m: LiveMsg) => `data: ${JSON.stringify(m)}\n\n`;

async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('Zeitlimit');
    await sleep(10);
  }
}

/** Fake-Recorder: SSE-Server, an den der Test Nachrichten schreibt. */
async function fakeRecorder() {
  const clients = new Set<ServerResponse>();
  let connects = 0;
  const srv = createServer((req, res) => {
    connects++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': ok\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
  }).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  return {
    url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/live`,
    clients,
    connects: () => connects,
    send: (s: string) => {
      for (const c of clients) c.write(s);
    },
    drop: () => {
      for (const c of clients) c.destroy();
    },
    close: () => new Promise<void>((r) => srv.close(() => r())),
  };
}

/** SSE-Leser: Nachrichten eines /live-Stroms (fetch), zusammengesetzt in einem LiveBook. */
async function reader(url: string, ac: AbortController) {
  const res = await fetch(url, { signal: ac.signal });
  const msgs: LiveMsg[] = [];
  const book = new LiveBook('BTCUSDT');
  const results: string[] = [];
  void (async () => {
    const dec = new TextDecoder();
    let buf = '';
    try {
      for await (const chunk of res.body!) {
        buf += dec.decode(chunk, { stream: true });
        for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (!block.startsWith('data: ')) continue;
          const m = parseLiveMsg(JSON.parse(block.slice(6)))!;
          msgs.push(m);
          results.push(book.apply(m));
        }
      }
    } catch {
      /* abgebrochen */
    }
  })();
  return { res, msgs, book, results };
}

async function hubServer(hub: LiveHub): Promise<{ url: string; srv: Server }> {
  const srv = createServer((req, res) => hub.attach('BTCUSDT', res)).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/`, srv };
}

describe('LiveHub', () => {
  const cleanup: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const f of cleanup.splice(0).reverse()) await f();
  });

  it('snap beim Verbinden, eigene lückenlose Folgenummern, Upstream-Sprung → Neuverbindung, Ausfall → status', async () => {
    const up = await fakeRecorder();
    cleanup.push(() => up.close());
    const hub = new LiveHub({ url: up.url, maxClients: 10, statusEveryMs: 100 });
    cleanup.push(() => hub.stop());
    hub.start();
    await until(() => up.clients.size === 1);
    up.send(sse(snap(40, [bar(T0 - MINUTE_MS, 5)])));
    up.send(sse(tick(41, 6)));
    await until(() => hub.stats.upstreamMessages === 2);
    const { url, srv } = await hubServer(hub);
    cleanup.push(() => new Promise<void>((r) => (srv.closeAllConnections(), srv.close(() => r()))));
    const ac = new AbortController();
    cleanup.push(() => ac.abort());
    const c = await reader(url, ac);
    expect(c.res.headers.get('content-type')).toMatch(/text\/event-stream/);
    expect(c.res.headers.get('x-accel-buffering')).toBe('no');
    await until(() => c.msgs.length === 1);
    expect(c.msgs[0]!.t).toBe('snap');
    expect(c.book.bars.get(T0)!.close).toBe(6);
    up.send(sse(tick(42, 7)) + sse(tick(42, 99))); // Dublette wird nicht weitergereicht
    await until(() => c.msgs.length === 2);
    expect(c.book.price).toBe(7);
    // Sprung im Upstream (43 fehlt) → nicht weiterreichen, neu verbinden, neuer snap wird verteilt
    up.send(sse(tick(44, 8)));
    await until(() => up.connects() === 2 && up.clients.size === 1, 8_000);
    expect(hub.stats.upstreamGaps).toBe(1);
    up.send(sse(snap(0, [bar(T0, 9)])));
    await until(() => c.book.price === null && c.book.bars.get(T0)?.close === 9);
    expect(c.results.every((r) => r === 'ok')).toBe(true);
    // Upstream fällt aus → status recorder: false (wiederholt als Herzschlag)
    up.drop();
    await until(() => c.book.status.recorder === false);
    const n = c.msgs.length;
    await until(() => c.msgs.length > n + 1);
    expect(c.results.every((r) => r === 'ok')).toBe(true);
    // neuer Client während des Ausfalls: snap mit recorder: false
    const c2 = await reader(url, ac);
    await until(() => c2.msgs.length >= 1);
    expect(c2.book.status.recorder).toBe(false);
  });

  it('langsamer Client (liest nicht) wird getrennt; die anderen bekommen weiter alles', async () => {
    const hub = new LiveHub({
      url: 'http://127.0.0.1:9/never',
      maxClients: 10,
      maxBuffer: 64 * 1024,
    });
    cleanup.push(() => hub.stop());
    const { url, srv } = await hubServer(hub);
    cleanup.push(() => new Promise<void>((r) => (srv.closeAllConnections(), srv.close(() => r()))));
    // Roh-Socket, der nie liest
    const port = Number(new URL(url).port);
    const sock = connect(port, '127.0.0.1');
    sock.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n');
    sock.pause();
    cleanup.push(() => void sock.destroy());
    const ac = new AbortController();
    cleanup.push(() => ac.abort());
    const good = await reader(url, ac);
    await until(() => hub.size === 2);
    expect(hub.onUpstream(snap(0))).toBe(true);
    const big = Array.from({ length: 200 }, (_, i) => bar(T0 + i * MINUTE_MS, i + 1));
    let seq = 1;
    const t0 = Date.now();
    while (hub.stats.dropped === 0 && Date.now() - t0 < 15_000) {
      hub.onUpstream({ ...tick(seq++, 1), bars: big });
      await sleep(2);
    }
    expect(hub.stats.dropped).toBe(1);
    expect(hub.size).toBe(1);
    await until(() => good.book.seq === seq, 15_000); // Verteiler zählt selbst (snap + ticks)
    expect(good.results.every((r) => r === 'ok')).toBe(true);
  }, 40_000);

  it('Clientgrenze: darüber 503', async () => {
    const hub = new LiveHub({ url: 'http://127.0.0.1:9/never', maxClients: 2 });
    cleanup.push(() => hub.stop());
    const { url, srv } = await hubServer(hub);
    cleanup.push(() => new Promise<void>((r) => (srv.closeAllConnections(), srv.close(() => r()))));
    const ac = new AbortController();
    cleanup.push(() => ac.abort());
    const a = await fetch(url, { signal: ac.signal });
    const b = await fetch(url, { signal: ac.signal });
    const c = await fetch(url, { signal: ac.signal });
    expect([a.status, b.status, c.status]).toEqual([200, 200, 503]);
    expect(hub.stats.rejected).toBe(1);
    expect(hub.full).toBe(true);
  });
});

describe('Route /api/v1/live', () => {
  it('SSE mit CORS-Kopf, unbekanntes Symbol 404, ohne Hub 503, zu viele Clients 503', async () => {
    const cfg = parseApiConfig({
      OF_DB_HOST: 'localhost',
      OF_DB_PORT: '5432',
      OF_DB_USER: 'admin',
      OF_DB_PASSWORD: 'x',
      OF_DB_NAME: 'orderflow',
      OF_API_DB_PASSWORD: 'y',
      OF_API_LIVE_MAX: '1',
      OF_API_RECORDER_LIVE_URL: 'http://127.0.0.1:9/live',
    });
    expect(cfg.liveMaxClients).toBe(1);
    expect(cfg.recorderLiveUrl).toBe('http://127.0.0.1:9/live');
    const hub = new LiveHub({ url: cfg.recorderLiveUrl!, maxClients: cfg.liveMaxClients });
    const catalog = { symbol: (n: string) => (n === 'BTCUSDT' ? {} : undefined) };
    const app = buildApp({ cfg, catalog, live: hub } as unknown as Deps, { logger: false });
    const off = buildApp({ cfg, catalog, live: null } as unknown as Deps, { logger: false });
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    const offUrl = await off.listen({ host: '127.0.0.1', port: 0 });
    const ac = new AbortController();
    try {
      const r = await fetch(`${url}/api/v1/live?sym=BTCUSDT`, {
        signal: ac.signal,
        headers: { origin: 'http://localhost:5173' },
      });
      expect(r.status).toBe(200);
      expect(r.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
      expect(r.headers.get('cache-control')).toBe('no-store');
      const first = await r.body!.getReader().read();
      expect(new TextDecoder().decode(first.value)).toMatch(/^data: \{"v":1,"t":"snap"/);
      expect((await fetch(`${url}/api/v1/live?sym=BTCUSDT`)).status).toBe(503); // Grenze 1
      expect((await fetch(`${url}/api/v1/live?sym=NOPE`)).status).toBe(404);
      expect((await fetch(`${url}/api/v1/live?sym=BTCUSDT&x=1`)).status).toBe(400);
      expect((await fetch(`${offUrl}/api/v1/live?sym=BTCUSDT`)).status).toBe(503);
    } finally {
      ac.abort();
      await app.close(); // preClose beendet die Live-Clients, sonst hinge close
      await off.close();
      await hub.stop();
    }
  });
});
