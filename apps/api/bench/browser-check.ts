// Echtdaten-Prüfung im Browser: Web-App (zweiter Vite-Dev-Server mit VITE_API_BASE auf diese API)
// in Chromium öffnen und für BTCUSDT 1m/5m/15m/1h prüfen, dass Kerzen und Footprint gezeichnet
// werden, kein roter Abweichungs-Banner erscheint, die Querprüfung des Clients nichts meldet und keine
// Seitenfehler auftreten. Screenshots nach apps/api/docs-screenshots/.
//
//   PLAYWRIGHT_CORE=<pfad zu playwright-core> WEB_URL=http://127.0.0.1:5174/ node apps/api/bench/browser-check.ts
//
// Playwright ist keine Projektabhängigkeit (wie apps/web/perf/measure.ts).
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/* eslint-disable @typescript-eslint/no-explicit-any -- Playwright dynamisch, ohne Typen */
type Any = any;
const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pw: Any = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');
const URL0 = process.env.WEB_URL ?? 'http://127.0.0.1:5174/';
const SHOTS = join(here, '..', 'docs-screenshots');

async function main(): Promise<number> {
  await mkdir(SHOTS, { recursive: true });
  const browser = await pw.chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    deviceScaleFactor: 1,
  });
  const results: Record<string, unknown>[] = [];
  let failed = false;
  for (const tf of ['1m', '5m', '15m', '1h']) {
    const page = await ctx.newPage();
    const errors: string[] = [];
    const api: { url: string; status: number }[] = [];
    page.on('pageerror', (e: Error) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m: Any) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
    page.on('response', (r: Any) => {
      if (r.url().includes('/api/v1/')) api.push({ url: r.url(), status: r.status() });
    });
    await page.goto(`${URL0}?sym=BTCUSDT&tf=${tf}`, { waitUntil: 'load' });
    await page.waitForFunction(() => (window as Any).__of?.debugSnapshot, null, {
      timeout: 30_000,
    });
    const snap = () => page.evaluate(() => (window as Any).__of.debugSnapshot());
    // warten, bis keine Anfragen mehr laufen
    for (let i = 0; i < 100; i++) {
      const s = await snap();
      if (
        s.fpQueue.inFlight === 0 &&
        s.barQueue.inFlight === 0 &&
        s.fpQueue.queued === 0 &&
        s.readout?.fpTiles > 0
      )
        break;
      await page.waitForTimeout(200);
    }
    await page.waitForTimeout(800);
    const idle = async () => {
      for (let i = 0; i < 100; i++) {
        const q = await snap();
        if (q.fpQueue.inFlight === 0 && q.barQueue.inFlight === 0 && q.fpQueue.queued === 0) break;
        await page.waitForTimeout(200);
      }
      await page.waitForTimeout(500);
    };
    const shotLatest = join(SHOTS, `btcusdt-${tf}-latest.png`);
    await page.screenshot({ path: shotLatest });
    // in die Vergangenheit (finale Tage) ziehen: dort prüft der Client jede Kachel gegen /bars
    for (let k = 0; k < (tf === '1m' ? 70 : 12); k++) {
      await page.mouse.move(300, 450);
      await page.mouse.down();
      await page.mouse.move(1400, 450, { steps: 12 });
      await page.mouse.up();
      await idle();
    }
    const s = await snap();
    const internals = await page.evaluate(() => {
      const c = (window as Any).__of;
      const tiles = [...(c.fpStore?.lru?.values?.() ?? [])];
      return {
        tilesLoaded: tiles.length,
        finalTiles: tiles.filter((t: Any) => t.final).length,
        crossFails: c.crossFails?.size ?? null,
        visibleFrom: c.items?.length ? new Date(c.items[0].time * 1000).toISOString() : null,
      };
    });
    const banner = await page.locator('.banner').count();
    const bannerText = banner ? await page.locator('.banner').innerText() : null;
    const shot = join(SHOTS, `btcusdt-${tf}.png`);
    await page.screenshot({ path: shot });
    const bad = api.filter((a) => a.status >= 400);
    const fpOk = api.filter((a) => a.url.includes('/footprint') && a.status === 200).length;
    const barsOk = api.filter((a) => a.url.includes('/bars') && a.status === 200).length;
    const r = {
      tf,
      ...internals,
      screenshotLatest: shotLatest,
      R: s.readout?.R,
      lod: s.readout?.lod,
      fpTiles: s.readout?.fpTiles,
      fpCells: s.readout?.fpCells,
      cellsDrawn: s.readout?.cellsDrawn,
      windowBars: s.readout?.windowBars,
      banner: bannerText,
      blocked: s.readout?.blocked ?? null,
      readoutError: s.readout?.error ?? null,
      fpLastError: s.fpQueue.lastError ?? null,
      barLastError: s.barQueue.lastError ?? null,
      apiFootprint200: fpOk,
      apiBars200: barsOk,
      apiErrors: bad,
      pageErrors: errors,
      screenshot: shot,
    };
    const ok =
      !bannerText &&
      !r.blocked &&
      !r.readoutError &&
      !r.fpLastError &&
      !r.barLastError &&
      bad.length === 0 &&
      errors.length === 0 &&
      fpOk > 0 &&
      barsOk > 0 &&
      (r.fpTiles as number) > 0 &&
      (r.cellsDrawn as number) > 0 &&
      internals.crossFails === 0 &&
      internals.finalTiles > 0;
    if (!ok) failed = true;
    results.push({ ok, ...r });
    await page.close();
  }
  await browser.close();
  await writeFile(join(SHOTS, 'browser-check.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  return failed ? 1 : 0;
}

main().then(
  (c) => {
    process.exitCode = c;
  },
  (e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  },
);
