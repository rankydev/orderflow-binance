// Minimaler, streamender ZIP-Leser für Binance-Vision-Dumps (genau ein Eintrag, deflate oder
// stored, ZIP64-fähig). Liest nur lesend; konstanter Speicher; prüft CRC32 und unkomprimierte Größe
// des Eintrags am Ende des Streams. Keine Fremdabhängigkeit.
import { open } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream';
import { crc32, createInflateRaw } from 'node:zlib';

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

export interface ZipEntry {
  name: string;
  method: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  dataOffset: number;
}

const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOC = 0x07064b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_CD = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

function u64(b: Buffer, off: number): number {
  const v = b.readBigUInt64LE(off);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipError('ZIP64-Wert zu groß');
  return Number(v);
}

/** Liest das Zentralverzeichnis und verlangt genau einen Eintrag. */
export async function readSingleEntry(path: string): Promise<ZipEntry> {
  const fh = await open(path, 'r');
  try {
    const size = (await fh.stat()).size;
    const tailLen = Math.min(size, 65_557 + 20);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === SIG_EOCD) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new ZipError(`${path}: kein ZIP-Endverzeichnis gefunden`);
    let entries = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);
    if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const loc = eocd - 20;
      if (loc < 0 || tail.readUInt32LE(loc) !== SIG_ZIP64_LOC) {
        throw new ZipError(`${path}: ZIP64-Locator fehlt`);
      }
      const z64off = u64(tail, loc + 8);
      const z = Buffer.alloc(56);
      await fh.read(z, 0, 56, z64off);
      if (z.readUInt32LE(0) !== SIG_ZIP64_EOCD)
        throw new ZipError(`${path}: ZIP64-Endverzeichnis fehlt`);
      entries = u64(z, 32);
      cdSize = u64(z, 40);
      cdOffset = u64(z, 48);
    }
    if (entries !== 1) throw new ZipError(`${path}: erwartet genau 1 Eintrag, gefunden ${entries}`);
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);
    if (cd.readUInt32LE(0) !== SIG_CD) throw new ZipError(`${path}: Zentralverzeichnis beschädigt`);
    const flags = cd.readUInt16LE(8);
    const method = cd.readUInt16LE(10);
    const crc = cd.readUInt32LE(16);
    let compressedSize = cd.readUInt32LE(20);
    let uncompressedSize = cd.readUInt32LE(24);
    const nameLen = cd.readUInt16LE(28);
    const extraLen = cd.readUInt16LE(30);
    let localOffset = cd.readUInt32LE(42);
    const name = cd.toString('utf8', 46, 46 + nameLen);
    if (flags & 1) throw new ZipError(`${path}: verschlüsselte Einträge werden nicht unterstützt`);
    if (method !== 0 && method !== 8)
      throw new ZipError(`${path}: Kompressionsmethode ${method} nicht unterstützt`);
    // ZIP64-Extrafeld (0x0001): nur die Felder, die im Kopf 0xFFFFFFFF sind, in fester Reihenfolge.
    let p = 46 + nameLen;
    const end = p + extraLen;
    while (p + 4 <= end) {
      const id = cd.readUInt16LE(p);
      const len = cd.readUInt16LE(p + 2);
      if (id === 0x0001) {
        let q = p + 4;
        if (uncompressedSize === 0xffffffff) {
          uncompressedSize = u64(cd, q);
          q += 8;
        }
        if (compressedSize === 0xffffffff) {
          compressedSize = u64(cd, q);
          q += 8;
        }
        if (localOffset === 0xffffffff) {
          localOffset = u64(cd, q);
        }
      }
      p += 4 + len;
    }
    const lh = Buffer.alloc(30);
    await fh.read(lh, 0, 30, localOffset);
    if (lh.readUInt32LE(0) !== SIG_LOCAL) throw new ZipError(`${path}: lokaler Kopf beschädigt`);
    const dataOffset = localOffset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
    if (dataOffset + compressedSize > size) throw new ZipError(`${path}: Datei abgeschnitten`);
    return { name, method, crc, compressedSize, uncompressedSize, dataOffset };
  } finally {
    await fh.close();
  }
}

/**
 * Streamt den einzigen Eintrag als Buffer-Stücke. Wirft am Ende, wenn CRC32 oder Größe nicht
 * stimmen – der Aufrufer darf Ergebnisse erst nach vollständigem Durchlauf verwenden.
 */
export async function* streamSingleEntry(
  path: string,
  entry?: ZipEntry,
): AsyncGenerator<Buffer, void, void> {
  const e = entry ?? (await readSingleEntry(path));
  const hwm = 1 << 20;
  if (e.compressedSize === 0) {
    if (e.uncompressedSize !== 0) throw new ZipError(`${path}: leerer Eintrag mit Größe ≠ 0`);
    return;
  }
  const raw = createReadStream(path, {
    start: e.dataOffset,
    end: e.dataOffset + e.compressedSize - 1,
    highWaterMark: hwm,
  });
  const src: NodeJS.ReadableStream =
    e.method === 8 ? pipeline(raw, createInflateRaw({ chunkSize: hwm }), () => {}) : raw;
  let crc = 0;
  let total = 0;
  for await (const chunk of src as AsyncIterable<Buffer>) {
    crc = crc32(chunk, crc);
    total += chunk.length;
    yield chunk;
  }
  if (total !== e.uncompressedSize) {
    throw new ZipError(`${path}: unkomprimierte Größe ${total} ≠ ${e.uncompressedSize}`);
  }
  if (crc >>> 0 !== e.crc >>> 0) throw new ZipError(`${path}: CRC32 stimmt nicht`);
}

/** Zerlegt einen Buffer-Strom in Zeilen-Blöcke: liefert (Text, Zeilenanfänge) ohne Teilstrings je Zeile. */
export async function* textBlocks(
  chunks: AsyncIterable<Buffer>,
): AsyncGenerator<{ text: string; lineEnd: number }, void, void> {
  let carry = '';
  for await (const chunk of chunks) {
    const s = carry + chunk.toString('latin1');
    const lastNl = s.lastIndexOf('\n');
    if (lastNl < 0) {
      carry = s;
      continue;
    }
    carry = s.slice(lastNl + 1);
    yield { text: s, lineEnd: lastNl + 1 };
  }
  if (carry.length > 0) yield { text: carry + '\n', lineEnd: carry.length + 1 };
}
