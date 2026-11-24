// Render-Performance-Messung im echten Browser (KONZEPT §1.4, Test T11). Startet nichts selbst:
// erwartet den Vite-Dev-Server (mit Fixtures) unter PERF_URL (Standard http://127.0.0.1:5173/).
//
//   PLAYWRIGHT_CORE=<pfad zu playwright-core> PERF_OUT=<verzeichnis> node perf/measure.ts
//
// Playwright ist keine Projektabhängigkeit; der Pfad zu einem lokal vorhandenen playwright-core wird
// per PLAYWRIGHT_CORE übergeben (sonst `playwright-core`/`playwright` aus der Modulauflösung).
// Ergebnisse: <PERF_OUT>/perf-results.json; Screenshots nach apps/web/docs-screenshots/.
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/* eslint-disable @typescript-eslint/no-explicit-any -- Playwright wird dynamisch geladen, ohne Typen */
type Any = any;

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pwPath = process.env.PLAYWRIGHT_CORE;
const pw: Any = pwPath
  ? require(pwPath)
  : (() => {
      try {
        return require('playwright-core');
      } catch {
        return require('playwright');
      }
    })();
const URL0 = process.env.PERF_URL ?? 'http://127.0.0.1:5173/';
const OUT = resolve(process.env.PERF_OUT ?? join(here, '..', 'perf-out'));
const SHOTS = resolve(join(here, '..', 'docs-screenshots'));
const VIEW = { width: 1600, height: 900 };

// Im Browser vor dem App-Code: rAF-Rückrufe je Frame timen (Arbeit inkl. Bibliothek), Frame-Abstände,
// Long Tasks. Die Messung beeinflusst die App nicht (nur Hüllfunktion um requestAnimationFrame).
const INIT = `(() => {
  const P = { work: [], interval: [], longTasks: [], lastTs: 0, cur: 0, curTs: -1 };
  window.__perf = P;
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => raf((ts) => {
    if (ts !== P.curTs) {
      if (P.curTs >= 0) { P.work.push(P.cur); P.interval.push(P.curTs - P.lastTs); P.lastTs = P.curTs; }
      else { P.lastTs = ts; }
      P.curTs = ts; P.cur = 0;
    }
    const t0 = performance.now();
    try { cb(ts); } finally { P.cur += performance.now() - t0; }
  });
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) P.longTasks.push({ start: e.startTime, dur: e.duration }); })
      .observe({ type: 'longtask', buffered: true });
  } catch {}
})();`;

function stats(a: number[]) {
  if (a.length === 0) return { n: 0, median: 0, p95: 0, max: 0 };
  const s = [...a].sort((x, y) => x - y);
  const q = (p: number) => s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]!;
  return {
    n: s.length,
    median: +q(0.5).toFixed(2),
    p95: +q(0.95).toFixed(2),
    max: +s[s.length - 1]!.toFixed(2),
  };
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  await mkdir(SHOTS, { recursive: true });
  const browser = await pw.chromium.launch({ args: ['--enable-precise-memory-info'] });
  const ctx = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 2 });
  await ctx.addInitScript(INIT);
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  const errors: string[] = [];
  page.on('pageerror', (e: Error) => errors.push(e.message));
  page.on('console', (m: Any) => m.type() === 'error' && errors.push(m.text()));
  const requests: string[] = [];
  page.on('request', (r: Any) => {
    if (r.url().includes('/api/v1/')) requests.push(r.url());
  });

  const snap = () => page.evaluate(() => (window as Any).__of.debugSnapshot());
  const readout = async () => (await snap()).readout;
  const perfLen = () =>
    page.evaluate(() => {
      const P = (window as Any).__perf;
      return {
        work: P.work.length,
        lt: P.longTasks.length,
        frames: (window as Any).__of.rc.stats.frames,
        t: performance.now(),
      };
    });
  const perfSince = async (m: Any) =>
    page.evaluate((m0: Any) => {
      const P = (window as Any).__perf;
      return {
        work: P.work.slice(m0.work),
        interval: P.interval.slice(m0.work),
        longTasks: P.longTasks.slice(m0.lt).filter((x: Any) => x.dur > 50),
        draw: (window as Any).__of.drawTimes(m0.frames),
        elapsed: performance.now() - m0.t,
      };
    }, m);
  const idle = async (ms = 400) => {
    await page.waitForTimeout(ms);
    for (let i = 0; i < 50; i++) {
      const s = await snap();
      if (
        !s.gestureActive &&
        s.fpQueue.inFlight === 0 &&
        s.barQueue.inFlight === 0 &&
        s.fpQueue.queued === 0
      )
        break;
      await page.waitForTimeout(100);
    }
    await page.waitForTimeout(150);
  };
  const heap = async () => {
    await cdp.send('HeapProfiler.collectGarbage');
    const h = await cdp.send('Runtime.getHeapUsage');
    return +(h.usedSize / 1e6).toFixed(1);
  };
  const box = await (async () => {
    await page.goto(URL0);
    await page.waitForFunction(
      () => performance.getEntriesByName('of:first-footprint').length > 0,
      null,
      { timeout: 15_000 },
    );
    const b = await page.locator('.chart').boundingBox();
    return b as { x: number; y: number; width: number; height: number };
  })();
  const cx = box.x + box.width / 2 - 40;
  const cy = box.y + box.height / 2;
  const results: Record<string, Any> = {};
  const marks = await page.evaluate(() =>
    Object.fromEntries(
      performance.getEntriesByType('mark').map((m) => [m.name, +m.startTime.toFixed(1)]),
    ),
  );
  const nav = await page.evaluate(() => {
    const n = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
    return {
      domContentLoaded: +n.domContentLoadedEventEnd.toFixed(1),
      load: +n.loadEventEnd.toFixed(1),
    };
  });
  results.firstRender = { ...marks, ...nav, readout: await readout() };
  await idle();
  const cellsSamples: number[] = [];
  const sampleCells = async () => {
    const r = await readout();
    cellsSamples.push(r.cellsDrawn);
  };

  async function drag(dx: number, steps: number, stepMs = 16) {
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    for (let i = 1; i <= steps; i++) {
      await page.mouse.move(cx + (dx * i) / steps, cy);
      await page.waitForTimeout(stepMs);
    }
    await page.mouse.up();
  }
  /** Preisachse nach oben ziehen = Zeilen vertikal strecken (Geste). */
  async function stretch(px: number) {
    const x = box.x + box.width - 30;
    await page.mouse.move(x, cy + 100);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) {
      await page.mouse.move(x, cy + 100 - (px * i) / 10);
      await page.waitForTimeout(16);
    }
    await page.mouse.up();
  }
  async function wheel(dy: number, times: number, waitMs = 40) {
    await page.mouse.move(cx + 200, cy);
    for (let i = 0; i < times; i++) {
      await page.mouse.wheel(0, dy);
      await page.waitForTimeout(waitMs);
    }
  }
  const scenario = async (name: string, fn: () => Promise<void>) => {
    const m = await perfLen();
    const r0 = requests.length;
    await fn();
    const p = await perfSince(m);
    const s = await snap();
    results[name] = {
      frameWork: stats(p.work),
      frameInterval: stats(p.interval),
      footprintDraw: stats(p.draw),
      longTasks: p.longTasks.length,
      longTaskMax: p.longTasks.reduce((a: number, x: Any) => Math.max(a, x.dur), 0),
      requests: requests.length - r0,
      seconds: +(p.elapsed / 1000).toFixed(1),
      readout: s.readout,
      maxVcWithCells: s.maxVcWithCells,
      maxCellsDrawn: s.maxCellsDrawn,
    };
    console.log(name, JSON.stringify(results[name]));
  };

  // 1) Kontinuierliches Pannen (1m, L2), hin und zurück, dreimal – Requests je Durchgang.
  const passReq: number[] = [];
  await scenario('pan_1m', async () => {
    for (let pass = 0; pass < 3; pass++) {
      const r0 = requests.length;
      await drag(900, 60);
      await sampleCells();
      await drag(900, 60);
      await sampleCells();
      await drag(-900, 60);
      await drag(-900, 60);
      await idle(300);
      passReq.push(requests.length - r0);
    }
  });
  results.pan_1m.requestsPerPass = passReq;

  // 2) Zoom: hinein bis L3, heraus bis L1, wieder hinein (alle drei Stufen).
  const lodsSeen = new Set<number>();
  const lodTrace: Any[] = [];
  const trace = async (label: string) => {
    const r = await readout();
    lodsSeen.add(r.lod);
    lodTrace.push({
      label,
      lod: r.lod,
      R: r.R,
      bs: +r.barSpacing.toFixed(1),
      rh: +r.rowHeight.toFixed(1),
      vc: r.visibleCells,
      cells: r.cellsDrawn,
    });
    cellsSamples.push(r.cellsDrawn);
  };
  await scenario('zoom_1m', async () => {
    for (let i = 0; i < 6; i++) {
      await wheel(-240, 4);
      await idle(250);
      await trace(`in${i}`);
    }
    // Zeilen vertikal strecken (Preisachse ziehen) → Auto-R wird feiner/gröber, L3 mit Zahlen
    for (let k = 0; k < 6; k++) {
      await stretch(40);
      await idle(300);
      await trace(`stretch${k}`);
      if ((await readout()).lod === 3) break;
    }
    for (let i = 0; i < 12; i++) {
      await wheel(240, 4);
      await idle(250);
      await trace(`out${i}`);
    }
    for (let i = 0; i < 8; i++) {
      await wheel(-240, 4);
      await idle(250);
      await trace(`in2_${i}`);
    }
  });
  results.zoom_1m.lodsSeen = [...lodsSeen].sort();
  results.zoom_1m.trace = lodTrace;

  // 3) Maus über dem Chart bewegen (Fadenkreuz), 5 s.
  await page.evaluate(() => (window as Any).__of.chart.timeScale().resetTimeScale());
  await idle();
  await scenario('mousemove', async () => {
    const t0 = Date.now();
    let i = 0;
    while (Date.now() - t0 < 5000) {
      const x = box.x + 20 + ((i * 13) % (box.width - 100));
      const y = box.y + 20 + ((i * 7) % (box.height - 60));
      await page.mouse.move(x, y);
      await page.waitForTimeout(8);
      i++;
    }
  });

  // Screenshots (echte Daten): L2-Zellen
  await page.goto(`${URL0}?sym=BTCUSDT&tf=1m&type=delta`);
  await page.waitForFunction(() => performance.getEntriesByName('of:first-footprint').length > 0);
  await idle();
  await page.screenshot({ path: join(SHOTS, 'l2-delta-cells-1m.png') });
  results.shots = { l2: await readout() };
  // L3 Delta: hineinzoomen und Zeilen strecken
  const toL3 = async () => {
    for (let k = 0; k < 20; k++) {
      const r = await readout();
      if (r.lod === 3) return r;
      if (r.barSpacing < 95) await wheel(-240, 2);
      else await stretch(r.rowHeight < 6 ? 60 : 30);
      await idle(300);
    }
    return readout();
  };
  results.shots.l3delta = await toL3();
  await page.screenshot({ path: join(SHOTS, 'l3-delta-numbers-1m.png') });
  await page.getByRole('button', { name: 'Bid×Ask' }).click();
  await idle();
  results.shots.l3bidask = await toL3();
  await page.screenshot({ path: join(SHOTS, 'l3-bidask-numbers-1m.png') });

  // T11: Zellbudget unter Last – manuelles R, fester Preisbereich so gewählt, dass knapp ≤ 25 000
  // Zellen sichtbar sind; dann pannen (vc schwankt; über dem Budget muss der Renderer auf Kerzen fallen).
  const tune = async (sym: string, tf: string, R: number, bs: number, h0: number) => {
    await page.goto(`${URL0}?sym=${sym}&tf=${tf}&type=delta`);
    await page.waitForFunction(() => performance.getEntriesByName('of:first-candles').length > 0);
    await idle();
    await page.evaluate(
      ([r, b]: number[]) => {
        const c = (window as Any).__of;
        c.reevaluate();
        c.setRowMode(r);
        c.chart.timeScale().applyOptions({ barSpacing: b });
        c.reevaluate();
      },
      [R, bs],
    );
    await idle(600);
    return page.evaluate(
      async ([hStart, b]: [number, number]) => {
        const c = (window as Any).__of;
        c.chart.timeScale().applyOptions({ barSpacing: b });
        const ts = c.chart.timeScale();
        const lr = ts.getVisibleLogicalRange();
        const it = c.items.slice(Math.max(0, Math.ceil(lr.from)), Math.floor(lr.to));
        const mids = it.map((b: Any) => (b.high + b.low) / 2).sort((a: number, b: number) => a - b);
        const mid = mids[mids.length >> 1];
        const setRange = (from: number, to: number) => {
          try {
            c.chart.priceScale('right').setVisibleRange({ from, to });
            return true;
          } catch (e) {
            errs.push(String(e));
            return false;
          }
        };
        const errs: string[] = [];
        const wait = () => new Promise((r) => setTimeout(r, 250));
        let best = { H: 0, vc: 0, lod: 1 };
        for (let H = hStart; H >= hStart / 100; H *= 0.93) {
          if (!setRange(mid - H / 2, mid + H / 2)) continue;
          // Preisskala wird erst beim nächsten Zeichnen übernommen: danach bewerten (wie Gestenende).
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          c.reevaluate();
          await wait();
          const st = c.rc.stats;
          if (c.readout().mode === 'footprint' && st.lod >= 2 && st.vc > best.vc)
            best = { H, vc: st.vc, lod: st.lod };
        }
        setRange(mid - best.H / 2, mid + best.H / 2);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        c.reevaluate();
        await wait();
        c.reevaluate();
        await wait();
        return {
          errors: errs.slice(0, 3),
          ...best,
          rh: c.rc.stats.rh,
          bs: c.rc.stats.bs,
          cells: c.rc.stats.cellsDrawn,
          mode: c.readout().mode,
        };
      },
      [h0, bs] as [number, number],
    );
  };
  // Echte (trendende) Daten füllen das Budget bei rh ≥ 2 px kaum (gemessen: < 6 000 Zellen); daher
  // zusätzlich das Seitwärts-Stresssymbol, bei dem jeder Bar dieselben ≈ 300 Zeilen belegt.
  const configs: [string, string, number, number, number][] = [
    ['BTCUSDT-SYN90', '1h', 10, 12, 3000],
    ['STRESS-FLAT', '1m', 2, 7, 200],
    ['STRESS-FLAT', '1m', 1, 7, 120], // zuletzt: die Seite bleibt in diesem Zustand für das Pannen
  ];
  let tuned: Any = null;
  const tunings: Any[] = [];
  for (const [sym, tf, R, bs, h0] of configs) {
    const t = { sym, tf, R, bsSet: bs, h0, ...(await tune(sym, tf, R, bs, h0)) };
    tunings.push(t);
    console.log('tune', JSON.stringify(t));
    if (!tuned || t.vc > tuned.vc) tuned = t;
  }
  results.stressTunings = tunings;
  results.stressTuning = tuned;
  await page.screenshot({ path: join(SHOTS, 'stress-near-budget-flat-1m.png') });
  await scenario('stress_pan_near_budget', async () => {
    for (let i = 0; i < 3; i++) {
      await drag(600, 50);
      await drag(-600, 50);
    }
    await idle(300);
  });
  {
    const s = await snap();
    results.stress_pan_near_budget.lodFrames = s.lodFrames;
    results.stress_pan_near_budget.budgetFallbacks = s.budgetFallbacks;
  }

  // 4) Langer Zeitraum (synthetisch, 90 Tage): Heap, Pannen über die Historie, L1-Kerzen.
  await page.goto(`${URL0}?sym=BTCUSDT-SYN90&tf=1m&type=delta`);
  await page.waitForFunction(() => performance.getEntriesByName('of:first-footprint').length > 0);
  await idle();
  results.heapAfterLoadSyn1m = await heap();
  await scenario('pan_long_1m', async () => {
    // schnell weit zurück pannen (viele Fenster- und Kachelwechsel)
    for (let i = 0; i < 12; i++) {
      await drag(1300, 25, 12);
      await idle(200);
    }
    for (let i = 0; i < 12; i++) {
      await drag(-1300, 25, 12);
      await idle(200);
    }
  });
  results.heapAfterPanSyn1m = await heap();
  for (const tf of ['15m', '1h']) {
    await page.getByRole('button', { name: tf, exact: true }).click();
    await idle(600);
    await scenario(`zoomout_long_${tf}`, async () => {
      for (let i = 0; i < 20; i++) {
        await wheel(240, 3, 30);
        await idle(150);
        await sampleCells();
      }
      await page.evaluate(() => (window as Any).__of.chart.timeScale().fitContent());
      await idle(500);
      for (let i = 0; i < 2; i++) {
        await drag(700, 40);
        await drag(-700, 40);
      }
      await idle(300);
    });
  }
  results.heapAfterLongRange = await heap();
  await page.screenshot({ path: join(SHOTS, 'l1-candles-90d-1h.png') });
  results.shots.l1 = await readout();
  // 15m über 90 Tage, L1, gepannt
  await page.getByRole('button', { name: '15m', exact: true }).click();
  await idle(600);
  await page.evaluate(() => (window as Any).__of.chart.timeScale().fitContent());
  await idle(600);
  await scenario('pan_long_15m_fit', async () => {
    await drag(800, 60);
    await drag(-800, 60);
    await idle(300);
  });
  await page.screenshot({ path: join(SHOTS, 'l1-candles-90d-15m.png') });
  results.heapEnd = await heap();
  const final = await snap();
  results.final = final;
  results.cellBudget = {
    maxVcWithCells: final.maxVcWithCells,
    maxCellsDrawn: final.maxCellsDrawn,
    sampledMaxDrawn: Math.max(0, ...cellsSamples),
    budget: 25_000,
  };
  results.totalApiRequests = requests.length;
  results.errors = errors;
  await writeFile(join(OUT, 'perf-results.json'), JSON.stringify(results, null, 2));
  console.log(
    'cellBudget',
    JSON.stringify(results.cellBudget),
    'heap',
    results.heapAfterLoadSyn1m,
    results.heapAfterPanSyn1m,
    results.heapAfterLongRange,
    results.heapEnd,
    'errors',
    errors.length,
  );
  await browser.close();
}

await main();
