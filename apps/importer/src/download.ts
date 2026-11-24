// Download von Binance-Vision-Tagesdateien (aggTrades, 1m-Klines) in den gespiegelten Pfad,
// zusammen mit der .CHECKSUM. Schreibt zuerst *.part, prüft SHA256, benennt dann atomar um.
// Vorhandene, geprüfte Dateien werden nie überschrieben. Bis zu 3 Versuche (KONZEPT §4.1).
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  absPath,
  isPresent,
  parseChecksumFile,
  relPath,
  verifyFile,
  type FileRef,
} from './files.ts';

export const VISION_BASE = 'https://data.binance.vision/data/';

/** Ohne Fortschritt länger als dies → Abbruch (ein hängender Download blockiert sonst ewig). */
const FETCH_TIMEOUT_MS = 15 * 60_000;

async function fetchOk(url: string): Promise<Response> {
  const r = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!r.ok || !r.body) throw new Error(`HTTP ${r.status} für ${url}`);
  return r;
}

export async function downloadFile(
  dataDir: string,
  ref: FileRef,
  log: (s: string) => void = () => {},
): Promise<{ path: string; sha256: string; skipped: boolean }> {
  const path = absPath(dataDir, ref);
  if (isPresent(path)) {
    const v = await verifyFile(path);
    return { path, sha256: v.sha256, skipped: true };
  }
  const url = VISION_BASE + relPath(ref);
  const name = path.split('/').pop()!;
  await mkdir(dirname(path), { recursive: true });
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const part = `${path}.part`;
    try {
      const cs = await (await fetchOk(`${url}.CHECKSUM`)).text();
      const want = parseChecksumFile(cs, name);
      const r = await fetchOk(url);
      const h = createHash('sha256');
      const body = Readable.fromWeb(r.body as never);
      body.on('data', (c: Buffer) => h.update(c));
      await pipeline(body, createWriteStream(part));
      const got = h.digest('hex');
      if (got !== want)
        throw new Error(`SHA256-Abweichung beim Download ${name}: ${got} ≠ ${want}`);
      await writeFile(`${part}.CHECKSUM`, cs);
      await rename(part, path);
      await rename(`${part}.CHECKSUM`, `${path}.CHECKSUM`);
      log(`geladen ${relPath(ref)} ${got}`);
      return { path, sha256: got, skipped: false };
    } catch (e) {
      lastErr = e;
      await rm(part, { force: true });
      await rm(`${part}.CHECKSUM`, { force: true });
      log(`Versuch ${attempt} fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
