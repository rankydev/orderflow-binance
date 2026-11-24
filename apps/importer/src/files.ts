// Pfade im Rohdatenarchiv (KONZEPT §3.1), SHA256-Prüfung gegen .CHECKSUM.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

export const VISION_ROOT = 'raw/binance-vision';

export type FileRef =
  | { kind: 'aggTrades'; origin: 'daily'; symbol: string; period: string }
  | { kind: 'aggTrades'; origin: 'monthly'; symbol: string; period: string }
  | { kind: 'klines'; origin: 'daily'; symbol: string; period: string };

/** Pfad relativ zu data/raw/binance-vision/ (Schlüssel in raw_file). */
export function relPath(ref: FileRef): string {
  const { symbol: s, period: p } = ref;
  if (ref.kind === 'klines') return `futures/um/daily/klines/${s}/1m/${s}-1m-${p}.zip`;
  return `futures/um/${ref.origin}/aggTrades/${s}/${s}-aggTrades-${p}.zip`;
}

export function absPath(dataDir: string, ref: FileRef): string {
  return join(dataDir, VISION_ROOT, relPath(ref));
}

/** Datei und .CHECKSUM vorhanden (eine laufende Übertragung schreibt die ZIP ohne CHECKSUM oder als .part). */
export function isPresent(path: string): boolean {
  return existsSync(path) && existsSync(`${path}.CHECKSUM`);
}

export async function sha256File(path: string): Promise<{ sha256: string; bytes: number }> {
  const h = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path, {
    highWaterMark: 1 << 22,
  }) as AsyncIterable<Buffer>) {
    h.update(chunk);
    bytes += chunk.length;
  }
  return { sha256: h.digest('hex'), bytes };
}

/** Inhalt einer Binance-.CHECKSUM-Datei: "<hex>  <dateiname>". */
export function parseChecksumFile(text: string, expectName: string): string {
  const m = /^([0-9a-f]{64})\s+(\S+)\s*$/.exec(text.trim());
  if (!m) throw new Error(`.CHECKSUM unlesbar: ${JSON.stringify(text.slice(0, 120))}`);
  if (m[2] !== expectName) throw new Error(`.CHECKSUM nennt ${m[2]}, erwartet ${expectName}`);
  return m[1]!;
}

export interface VerifiedFile {
  path: string;
  bytes: number;
  sha256: string;
  checksumExpected: string;
  /** mtime als ISO-Zeit (Näherung für downloaded_at). */
  mtime: string;
}

/** Prüft SHA256 der Datei gegen ihre .CHECKSUM; wirft bei Abweichung (nie stiller Erfolg). */
export async function verifyFile(path: string): Promise<VerifiedFile> {
  if (!isPresent(path)) throw new Error(`Datei oder .CHECKSUM fehlt: ${path}`);
  const name = path.split('/').pop()!;
  const expected = parseChecksumFile(await readFile(`${path}.CHECKSUM`, 'utf8'), name);
  const { sha256, bytes } = await sha256File(path);
  if (sha256 !== expected) {
    throw new Error(`SHA256-Abweichung ${path}: Datei ${sha256}, .CHECKSUM ${expected}`);
  }
  const st = await stat(path);
  return { path, bytes, sha256, checksumExpected: expected, mtime: st.mtime.toISOString() };
}
