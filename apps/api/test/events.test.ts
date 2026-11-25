// Ereignis-Feed des Recorders (SSE): Minuten-Ereignisse stoßen die Katalog-Aktualisierung an; fremde
// oder kaputte Ereignisse werden ignoriert; nach einem Abbruch verbindet sich der Client neu.
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { parseApiConfig } from '../src/config.ts';
import { RecorderEvents } from '../src/recorder-events.ts';

const env = {
  OF_DB_HOST: 'localhost',
  OF_DB_PORT: '5432',
  OF_DB_USER: 'admin',
  OF_DB_PASSWORD: 'x',
  OF_DB_NAME: 'orderflow',
  OF_API_DB_PASSWORD: 'y',
};

async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('Zeitlimit');
    await sleep(10);
  }
}

describe('RecorderEvents (SSE)', () => {
  const cleanup: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const f of cleanup.splice(0)) await f();
  });

  it('minute-Ereignisse → Rückruf; andere Ereignisse, kaputtes JSON, \\r\\n und geteilte Pakete', async () => {
    const clients = new Set<ServerResponse>();
    let connects = 0;
    const srv = createServer((req, res) => {
      connects++;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': hallo\n\n'); // Kommentar, wird ignoriert (und sendet die Kopfzeilen)
      clients.add(res);
      req.on('close', () => clients.delete(res));
    }).listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/events`;
    const got: [string, number][] = [];
    const ev = new RecorderEvents(url, (s, t) => got.push([s, t]));
    cleanup.push(async () => {
      await ev.stop();
      for (const c of clients) c.destroy();
      await new Promise((r) => srv.close(r));
    });
    ev.start();
    await until(() => clients.size === 1 && ev.status.connected);
    const send = (s: string) => {
      for (const c of clients) c.write(s);
    };
    send('event: minute\ndata: {"symbol":"BTCUSDT","ts":60000}\n\n');
    send('event: other\ndata: {"symbol":"X","ts":1}\n\n');
    send('event: minute\ndata: kaputt\n\n');
    send('event: minute\r\ndata: {"symbol":"ETHUSDT",');
    await sleep(20);
    send('"ts":120000}\r\n\r\n');
    await until(() => got.length === 2);
    expect(got).toEqual([
      ['BTCUSDT', 60_000],
      ['ETHUSDT', 120_000],
    ]);
    expect(ev.status.events).toBe(2);
    // Server beendet die Verbindung → neu verbinden, danach kommen Ereignisse wieder an
    for (const c of clients) c.end();
    await until(() => connects === 2 && clients.size === 1, 10_000);
    expect(ev.status.reconnects).toBeGreaterThanOrEqual(1);
    send('event: minute\ndata: {"symbol":"BTCUSDT","ts":180000}\n\n');
    await until(() => got.length === 3);
  }, 20_000);

  it('nicht erreichbar: kein Absturz, Status mit Fehler, stop() beendet sofort', async () => {
    const ev = new RecorderEvents('http://127.0.0.1:9/events', () => {});
    ev.start();
    await until(() => ev.status.reconnects >= 1);
    expect(ev.status.connected).toBe(false);
    expect(ev.status.lastError).toBeTruthy();
    const t0 = Date.now();
    await ev.stop();
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('Konfiguration: aus ohne Variable; nur http(s) ohne Zugangsdaten', () => {
    expect(parseApiConfig(env).recorderEventsUrl).toBeNull();
    expect(
      parseApiConfig({ ...env, OF_API_RECORDER_EVENTS_URL: 'http://recorder:7701/events' })
        .recorderEventsUrl,
    ).toBe('http://recorder:7701/events');
    for (const bad of ['ftp://x/events', 'kein url', 'http://u:p@recorder:7701/events'])
      expect(() => parseApiConfig({ ...env, OF_API_RECORDER_EVENTS_URL: bad })).toThrow(
        /OF_API_RECORDER_EVENTS_URL/,
      );
  });
});
