// /events: Kopfzeilen und `: ok` sofort beim Verbinden, Keepalive-Kommentare, Minuten-Ereignisse.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { EventHub } from '../src/events.ts';

describe('EventHub (/events)', () => {
  it('antwortet sofort mit Kopfzeilen und `: ok`, sendet Keepalive und Minuten', async () => {
    const hub = new EventHub(100);
    const server = createServer((req, res) => hub.attach(req, res));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const ac = new AbortController();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/events`, { signal: ac.signal });
      // Kopfzeilen kommen ohne ein Ereignis abzuwarten
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/event-stream');
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let text = '';
      const until = async (re: RegExp) => {
        while (!re.test(text)) text += dec.decode((await reader.read()).value);
      };
      await until(/^: ok\n\n/);
      await until(/: keepalive\n\n/);
      hub.minute('BTCUSDT', 1_795_600_000_000);
      await until(/event: minute\ndata: \{"symbol":"BTCUSDT","ts":1795600000000\}\n\n/);
      expect(hub.size).toBe(1);
      ac.abort();
    } finally {
      hub.close();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('EventHub: Grenzen', () => {
  // Minimaler Fake einer ServerResponse für die Grenzfälle ohne Netz
  function fakeRes(writableLength = 0) {
    const handlers: Record<string, (() => void)[]> = {};
    return {
      writableLength,
      status: 0,
      writes: [] as string[],
      destroyed: false,
      ended: false,
      on(ev: string, f: () => void) {
        (handlers[ev] ??= []).push(f);
        return this;
      },
      emit(ev: string) {
        for (const f of handlers[ev] ?? []) f();
      },
      writeHead(code: number) {
        this.status = code;
        return this;
      },
      write(s: string) {
        this.writes.push(s);
        return true;
      },
      end() {
        this.ended = true;
      },
      destroy() {
        this.destroyed = true;
      },
    };
  }
  const fakeReq = () => ({ on: () => {} });
  type R = Parameters<EventHub['attach']>[1];
  type Q = Parameters<EventHub['attach']>[0];

  it('weitere Clients über der Grenze erhalten 503', () => {
    const hub = new EventHub(60_000, 2);
    const a = fakeRes();
    const b = fakeRes();
    const c = fakeRes();
    for (const r of [a, b, c]) hub.attach(fakeReq() as unknown as Q, r as unknown as R);
    expect([a.status, b.status, c.status]).toEqual([200, 200, 503]);
    expect(c.ended).toBe(true);
    expect(hub.size).toBe(2);
    hub.close();
  });

  it('ein Client mit mehr als der Puffergrenze wird getrennt, die anderen bekommen das Ereignis', () => {
    const hub = new EventHub(60_000, 16, 1024);
    const slow = fakeRes();
    const ok = fakeRes();
    hub.attach(fakeReq() as unknown as Q, slow as unknown as R);
    hub.attach(fakeReq() as unknown as Q, ok as unknown as R);
    slow.writableLength = 2048; // liest nicht mehr
    hub.minute('BTCUSDT', 1);
    expect(slow.destroyed).toBe(true);
    expect(hub.size).toBe(1);
    expect(hub.dropped).toBe(1);
    expect(ok.writes.at(-1)).toMatch(/event: minute/);
    hub.close();
  });

  it('ein Fehler auf der Antwort bleibt behandelt und entfernt den Client', () => {
    const hub = new EventHub(60_000);
    const r = fakeRes();
    hub.attach(fakeReq() as unknown as Q, r as unknown as R);
    expect(() => r.emit('error')).not.toThrow();
    expect(hub.size).toBe(0);
    hub.close();
  });
});

describe('EventHub: echter Server, Client liest nicht (S4)', () => {
  it('ein ins Stocken geratener Client wird nach > 1 MB Puffer getrennt, der Prozess puffert nicht weiter', async () => {
    const { connect } = await import('node:net');
    const hub = new EventHub(60_000);
    const server = createServer((req, res) => hub.attach(req, res));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const sock = connect(port, '127.0.0.1');
    await new Promise<void>((r) => sock.once('connect', () => r()));
    sock.write('GET /events HTTP/1.1\r\nHost: x\r\n\r\n');
    sock.pause(); // liest nie: Kernel- und Prozesspuffer laufen voll
    try {
      while (hub.size === 0) await new Promise((r) => setTimeout(r, 5));
      let sent = 0;
      while (hub.dropped === 0 && sent < 500_000) {
        for (let i = 0; i < 2000; i++) hub.minute('BTCUSDT', 1_795_600_000_000 + sent++);
        await new Promise((r) => setImmediate(r));
      }
      expect(hub.dropped).toBe(1);
      expect(hub.size).toBe(0);
      // getrennt, bevor der Puffer weit über die Grenze wuchs (~65 Byte je Ereignis)
      expect(sent * 65).toBeLessThan(64 * 1024 * 1024);
    } finally {
      sock.destroy();
      hub.close();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
