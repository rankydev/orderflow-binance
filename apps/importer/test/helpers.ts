// Test-Hilfen: minimaler ZIP-Schreiber (ein Eintrag, deflate oder stored) und ein temporäres
// Rohdatenarchiv im Vision-Layout. Nur für Tests; schreibt ausschließlich in tmp-Verzeichnisse.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

export function makeZip(entryName: string, content: Buffer | string, method: 0 | 8 = 8): Buffer {
  const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'latin1');
  const comp = method === 8 ? deflateRawSync(data) : data;
  const crc = crc32(data) >>> 0;
  const name = Buffer.from(entryName, 'utf8');
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0);
  lh.writeUInt16LE(20, 4);
  lh.writeUInt16LE(0, 6);
  lh.writeUInt16LE(method, 8);
  lh.writeUInt32LE(crc, 14);
  lh.writeUInt32LE(comp.length, 18);
  lh.writeUInt32LE(data.length, 22);
  lh.writeUInt16LE(name.length, 26);
  lh.writeUInt16LE(0, 28);
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4);
  cd.writeUInt16LE(20, 6);
  cd.writeUInt16LE(0, 8);
  cd.writeUInt16LE(method, 10);
  cd.writeUInt32LE(crc, 16);
  cd.writeUInt32LE(comp.length, 20);
  cd.writeUInt32LE(data.length, 24);
  cd.writeUInt16LE(name.length, 28);
  cd.writeUInt32LE(0, 42);
  const cdOffset = lh.length + name.length + comp.length;
  const cdSize = cd.length + name.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([lh, name, comp, cd, name, eocd]);
}

export function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Schreibt eine ZIP + .CHECKSUM (Binance-Format) unter dataDir/raw/binance-vision/<rel>. */
export function putVisionFile(dataDir: string, rel: string, csv: string): string {
  const path = join(dataDir, 'raw/binance-vision', rel);
  mkdirSync(dirname(path), { recursive: true });
  const name = path.split('/').pop()!;
  const zip = makeZip(name.replace(/\.zip$/, '.csv'), csv);
  writeFileSync(path, zip);
  const sha = createHash('sha256').update(zip).digest('hex');
  writeFileSync(`${path}.CHECKSUM`, `${sha}  ${name}\n`);
  return path;
}
