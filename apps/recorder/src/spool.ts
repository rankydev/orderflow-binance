// Live-Spool (KONZEPT §3.1, §4.2): je Symbol, UTC-Tag und Stunde eine Datei
// `<dir>/<SYM>/<YYYY-MM-DD>/<HH>.csv.zst` im Vision-CSV-Format (ohne Kopfzeile), je Flush (≤ 1 s)
// ein eigener zstd-Frame, danach fsync. Nach einem Absturz ist höchstens der letzte Frame
// unvollständig; beim Lesen wird er verworfen (vollständige Zeilen davor bleiben, Duplikate löst der
// Feed per aggId). Per REST nachgeholte ID-Bereiche stehen in `<HH>.rest` ("von,bis" je Zeile),
// damit bar_1m.source nach einem Neustart stimmt.
import { formatDay, getSymbol, parseAggTradeLine } from '@orderflow/core';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statfsSync,
  writeSync,
  existsSync,
  truncateSync,
} from 'node:fs';
import { join } from 'node:path';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import type { FeedItem } from './feed.ts';

interface Open {
  key: string;
  fd: number;
  restFd: number;
}

export class SpoolWriter {
  private readonly dir: string;
  private readonly symbol: string;
  private buf: string[] = [];
  private restRanges: { from: number; to: number; key: string }[] = [];
  private bufKey = '';
  private open: Open | null = null;
  /** Zeitpunkt (ms) des ältesten noch nicht gesicherten Eintrags (0 = nichts offen). */
  oldestUnflushed = 0;
  flushes = 0;
  bytes = 0;
  /** Beim Öffnen gekürzte Dateien (abgeschnittener Frame aus einem Absturz). */
  truncatedOnOpen = 0;

  constructor(dir: string, symbol: string) {
    this.dir = dir;
    this.symbol = symbol;
  }

  private keyOf(T: number): string {
    const iso = new Date(T).toISOString();
    return `${iso.slice(0, 10)}/${iso.slice(11, 13)}`;
  }

  append(items: readonly FeedItem[], now = Date.now()): void {
    for (const it of items) {
      const key = this.keyOf(it.trade.T);
      if (key !== this.bufKey && this.buf.length > 0) this.flush();
      this.bufKey = key;
      this.buf.push(it.line);
      if (it.viaRest) {
        const last = this.restRanges[this.restRanges.length - 1];
        if (last && last.key === key && last.to === it.trade.a - 1) last.to = it.trade.a;
        else this.restRanges.push({ from: it.trade.a, to: it.trade.a, key });
      }
      if (this.oldestUnflushed === 0) this.oldestUnflushed = now;
    }
  }

  private file(key: string): Open {
    if (this.open?.key === key) return this.open;
    if (this.open) {
      closeSync(this.open.fd);
      closeSync(this.open.restFd);
    }
    const [day, hour] = key.split('/') as [string, string];
    const d = join(this.dir, this.symbol, day);
    mkdirSync(d, { recursive: true });
    const path = join(d, `${hour}.csv.zst`);
    // Nach einem Absturz kann die Datei mit einem abgeschnittenen Frame enden: vor dem Anhängen auf
    // das Ende des letzten vollständigen Frames kürzen, sonst wären alle später angehängten Frames
    // für den Leser verloren (er hört am ersten defekten Frame auf). Review W2.
    if (existsSync(path)) {
      const buf = readFileSync(path);
      const { rest } = zstdFrames(buf);
      if (rest > 0) {
        truncateSync(path, buf.length - rest);
        this.truncatedOnOpen++;
      }
    }
    this.open = {
      key,
      fd: openSync(path, 'a'),
      restFd: openSync(join(d, `${hour}.rest`), 'a'),
    };
    return this.open;
  }

  /** Gepufferte Zeilen als ein zstd-Frame anhängen und fsync (auch die REST-Bereiche). */
  flush(): void {
    if (this.buf.length === 0) return;
    const f = this.file(this.bufKey);
    const frame = zstdCompressSync(Buffer.from(this.buf.join('\n') + '\n', 'latin1'));
    writeSync(f.fd, frame);
    fsyncSync(f.fd);
    const mine = this.restRanges.filter((r) => r.key === this.bufKey);
    if (mine.length) {
      writeSync(f.restFd, mine.map((r) => `${r.from},${r.to}`).join('\n') + '\n');
      fsyncSync(f.restFd);
    }
    this.restRanges = this.restRanges.filter((r) => r.key !== this.bufKey);
    this.bytes += frame.length;
    this.flushes++;
    this.buf = [];
    this.oldestUnflushed = 0;
  }

  close(): void {
    this.flush();
    if (this.open) {
      closeSync(this.open.fd);
      closeSync(this.open.restFd);
      this.open = null;
    }
  }
}

/**
 * Zerlegt eine Datei in vollständige zstd-Frames (RFC 8878: Magic, Frame-Header, Blöcke bis zum
 * letzten, optionale Prüfsumme). Ein abgeschnittener oder beschädigter Rest wird nicht mitgeliefert.
 */
export function zstdFrames(buf: Buffer): { frames: Buffer[]; rest: number } {
  const frames: Buffer[] = [];
  let p = 0;
  while (p + 6 <= buf.length) {
    if (buf.readUInt32LE(p) !== 0xfd2fb528) break;
    const fhd = buf[p + 4]!;
    const fcsFlag = fhd >> 6;
    const single = (fhd >> 5) & 1;
    const checksum = (fhd >> 2) & 1;
    const dictFlag = fhd & 3;
    let q =
      p + 5 + (single ? 0 : 1) + [0, 1, 2, 4][dictFlag]! + [single ? 1 : 0, 2, 4, 8][fcsFlag]!;
    let ok = false;
    while (q + 3 <= buf.length) {
      const h = buf[q]! | (buf[q + 1]! << 8) | (buf[q + 2]! << 16);
      const last = h & 1;
      const type = (h >> 1) & 3;
      const size = h >>> 3;
      q += 3 + (type === 1 ? 1 : size);
      if (q > buf.length) break;
      if (last) {
        q += checksum ? 4 : 0;
        ok = q <= buf.length;
        break;
      }
    }
    if (!ok) break;
    frames.push(buf.subarray(p, q));
    p = q;
  }
  return { frames, rest: buf.length - p };
}

/** Dekomprimiert eine Spool-Datei; ein abgeschnittener letzter Frame wird verworfen. */
function readZstdTolerant(path: string): { text: string; truncated: boolean } {
  const { frames, rest } = zstdFrames(readFileSync(path));
  const parts: string[] = [];
  let truncated = rest > 0;
  for (const f of frames) {
    try {
      parts.push(zstdDecompressSync(f).toString('latin1'));
    } catch {
      truncated = true;
      break;
    }
  }
  return { text: parts.join(''), truncated };
}

/** Liest die Spool eines Tages in Stundenreihenfolge (Zeilen, die nicht parsen, sind ein Fehler). */
export async function readSpoolDay(
  dir: string,
  symbol: string,
  day: number,
): Promise<{ items: FeedItem[]; truncatedFiles: number }> {
  const spec = getSymbol(symbol);
  const d = join(dir, symbol, formatDay(day));
  let files: string[];
  try {
    files = readdirSync(d)
      .filter((f) => f.endsWith('.csv.zst'))
      .sort();
  } catch {
    return { items: [], truncatedFiles: 0 };
  }
  const items: FeedItem[] = [];
  let truncatedFiles = 0;
  for (const f of files) {
    const { text, truncated } = readZstdTolerant(join(d, f));
    if (truncated) truncatedFiles++;
    const ranges: [number, number][] = [];
    try {
      for (const l of readFileSync(join(d, f.replace('.csv.zst', '.rest')), 'utf8').split('\n')) {
        if (!l) continue;
        const [a, b] = l.split(',').map(Number) as [number, number];
        ranges.push([a, b]);
      }
    } catch {
      /* keine REST-Bereiche */
    }
    for (const line of text.split('\n')) {
      if (!line) continue;
      const trade = parseAggTradeLine(line, spec);
      const viaRest = ranges.some(([a, b]) => trade.a >= a && trade.a <= b);
      items.push({ trade, line, viaRest });
    }
  }
  return { items, truncatedFiles };
}

/** Spool-Tage löschen, die `keep(day)` nicht mehr braucht; liefert gelöschte Tage. */
export function pruneSpool(dir: string, symbol: string, keep: (day: string) => boolean): string[] {
  const base = join(dir, symbol);
  const out: string[] = [];
  let days: string[];
  try {
    days = readdirSync(base);
  } catch {
    return out;
  }
  for (const d of days) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && !keep(d)) {
      rmSync(join(base, d), { recursive: true, force: true });
      out.push(d);
    }
  }
  return out;
}

/** Freier Platz im Spool-Verzeichnis in Bytes. */
export function freeBytes(dir: string): number {
  mkdirSync(dir, { recursive: true });
  const s = statfsSync(dir);
  return s.bavail * s.bsize;
}

/**
 * Aufbewahrung der heruntergeladenen Tagesdateien (VPS: kurzes rollierendes Fenster, KONZEPT §2.3;
 * das Mac-Archiv ist die Quelle der Wahrheit). Löscht daily aggTrades- und 1m-Kline-Dateien samt
 * .CHECKSUM eines Symbols, deren Tag vor `oldestKeep` liegt und für den `isFinal(day)` gilt.
 */
export function pruneRaw(
  dataDir: string,
  symbol: string,
  oldestKeep: number,
  isFinal: (day: number) => boolean,
): string[] {
  const out: string[] = [];
  const dirs = [
    join(dataDir, 'raw/binance-vision/futures/um/daily/aggTrades', symbol),
    join(dataDir, 'raw/binance-vision/futures/um/daily/klines', symbol, '1m'),
  ];
  for (const dir of dirs) {
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      const m = /(\d{4}-\d{2}-\d{2})\.zip(\.CHECKSUM)?$/.exec(f);
      if (!m) continue;
      const day = Date.parse(`${m[1]}T00:00:00Z`) / 86_400_000;
      if (day < oldestKeep && isFinal(day)) {
        rmSync(join(dir, f), { force: true });
        out.push(f);
      }
    }
  }
  return out;
}
