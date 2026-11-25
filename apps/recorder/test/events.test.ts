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
