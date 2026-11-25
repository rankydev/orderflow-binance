// Render-Performance-Messung im echten Browser (KONZEPT §1.4, Test T11). Startet nichts selbst:
// erwartet den Vite-Dev-Server (mit Fixtures) unter PERF_URL (Standard http://127.0.0.1:5173/).
//
//   PLAYWRIGHT_CORE=<pfad zu playwright-core> PERF_OUT=<verzeichnis> node perf/measure.ts
//
// Playwright ist keine Projektabhängigkeit; der Pfad zu einem lokal vorhandenen playwright-core wird
// per PLAYWRIGHT_CORE übergeben (sonst `playwright-core`/`playwright` aus der Modulauflösung).
// Ergebnisse: <PERF_OUT>/perf-results.json; Screenshots nach apps/web/docs-screenshots/.
import { execSync } from 'node:child_process';
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
/** PERF_ONLY=profile: nur die Volume-Profile-Szenarien (z. B. gegen die echte API). */
const profileOnly = process.env.PERF_ONLY === 'profile';

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
  // Profil-422 sind erwartet (der Client fragt einmal mit suggestR neu an); der Browser meldet sie
  // trotzdem als Konsolenfehler – diese zählen nicht als Seitenfehler, werden aber berichtet.
  let profile422 = 0;
  page.on('response', (r: Any) => {
    if (r.status() === 422 && r.url().includes('/profile')) profile422++;
  });
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
  // W4: JS-Heap allein unterschätzt (ArrayBuffer-Speicher, Canvas-Bitmaps). Zusätzlich RSS der
  // Renderer- und GPU-Prozesse dieses Browsers (ps), nach erzwungener GC.
  const heap = async () => {
    await cdp.send('HeapProfiler.collectGarbage');
    const h = await cdp.send('Runtime.getHeapUsage');
    const ps = execSync('ps -axo rss=,command=', { encoding: 'utf8', maxBuffer: 1 << 24 });
    let renderer = 0;
    let gpu = 0;
    for (const line of ps.split('\n')) {
      if (!line.includes('playwright') && !line.includes('ms-playwright')) continue;
      const rss = Number(line.trim().split(/\s+/)[0]) / 1024;
      if (line.includes('--type=renderer')) renderer = Math.max(renderer, rss);
      if (line.includes('--type=gpu-process')) gpu = Math.max(gpu, rss);
    }
    return {
      jsHeapMB: +(h.usedSize / 1e6).toFixed(1),
      rendererRssMB: +renderer.toFixed(0),
      gpuRssMB: +gpu.toFixed(0),
    };
  };
  await cdp.send('Performance.enable');
  const taskDuration = async () => {
    const m = await cdp.send('Performance.getMetrics');
    return (m.metrics as { name: string; value: number }[]).find((x) => x.name === 'TaskDuration')!
      .value;
  };
  const box = await (async () => {
    await page.goto(URL0);
    await page.waitForFunction(
      (m: string) => performance.getEntriesByName(m).length > 0,
      profileOnly ? 'of:first-candles' : 'of:first-footprint',
      { timeout: 15_000 },
    );
    const b = await page.locator('.chart').boundingBox();
    return b as { x: number; y: number; width: number; height: number };
  })();
  const cx = box.x + box.width / 2 - 40;
  const cy = box.y + box.height / 2;
  const results: Record<string, Any> = {};
  const failures: string[] = [];
  const check = (what: string, ok: boolean) => {
    if (!ok) failures.push(what);
    console.log(ok ? 'OK  ' : 'FEHL', what);
  };
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
    const td0 = await taskDuration();
    await fn();
    const td = (await taskDuration()) - td0;
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
      // W4: gesamte Main-Thread-Zeit (inkl. Canvas-Befehle, Layout, GC) je Frame im Mittel
      mainThreadMsPerFrame: p.work.length > 0 ? +((td * 1000) / p.work.length).toFixed(2) : 0,
      maxPrepareMs: +s.counters.maxPrepareMs.toFixed(1),
      readout: s.readout,
      maxVcWithCells: s.maxVcWithCells,
      maxCellsDrawn: s.maxCellsDrawn,
    };
    console.log(name, JSON.stringify(results[name]));
  };

  if (!profileOnly) {
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

    // 2) Zoom nur horizontal (Mausrad): von der Startansicht (L3) heraus bis L1 und wieder hinein
    //    bis L3 – ohne die Preisachse anzufassen. Danach Preisachse strecken/stauchen: R folgt.
    const lodsSeen = new Set<number>();
    const lodTrace: Any[] = [];
    const row = (r: Any, label: string) => ({
      label,
      lod: r.lod,
      R: r.R,
      rLabel: r.rLabel,
      cls: r.rowClass,
      bs: +r.barSpacing.toFixed(1),
      rh: +r.rowHeight.toFixed(1),
      vc: r.visibleCells,
      cells: r.cellsDrawn,
      textBars: r.textBars,
      rowsMedian: r.rowsMedian,
      rowsMax: r.rowsMax,
      shortened: r.textsShortened,
      skipped: r.textsSkipped,
      hint: r.hint,
    });
    const trace = async (label: string) => {
      const r = await readout();
      lodsSeen.add(r.lod);
      lodTrace.push(row(r, label));
      cellsSamples.push(r.cellsDrawn);
    };
    await scenario('zoom_1m', async () => {
      await trace('start');
      for (let i = 0; i < 14; i++) {
        await wheel(240, 2);
        await idle(250);
        await trace(`out${i}`);
      }
      for (let i = 0; i < 14; i++) {
        await wheel(-240, 2);
        await idle(250);
        await trace(`in${i}`);
        if ((await readout()).lod === 3 && i > 3) break;
      }
      for (let k = 0; k < 3; k++) {
        await stretch(80);
        await idle(300);
        await trace(`stretch${k}`);
      }
      for (let k = 0; k < 5; k++) {
        await stretch(-80);
        await idle(300);
        await trace(`compress${k}`);
      }
    });
    results.zoom_1m.lodsSeen = [...lodsSeen].sort();
    results.zoom_1m.trace = lodTrace;

    // 3) Maus über dem Chart bewegen (Fadenkreuz), 5 s.
    await page.goto(`${URL0}?sym=BTCUSDT&tf=1m&type=delta`);
    await page.waitForFunction(() => performance.getEntriesByName('of:first-footprint').length > 0);
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

    // 4) Je Zeitrahmen (echte Tage): Startansicht, dann nur horizontal heraus bis L1/L2 und wieder
    //    hinein bis L3. Screenshots: Startansichten, 5m/15m nach horizontalem Zoom, Zellen-Stufe.
    results.shots = {};
    const perTf: Any[] = [];
    for (const tf of ['1m', '5m', '15m', '1h']) {
      await page.goto(`${URL0}?sym=BTCUSDT&tf=${tf}&type=delta`);
      await page.waitForFunction(
        () => performance.getEntriesByName('of:first-footprint').length > 0,
      );
      await idle();
      const def = row(await readout(), `${tf} start`);
      perTf.push(def);
      if (tf === '1m') await page.screenshot({ path: join(SHOTS, 'default-delta-1m.png') });
      let minLod = 3;
      let cellsShot = false;
      for (let i = 0; i < 10; i++) {
        await wheel(240, 2);
        await idle(250);
        const r = await readout();
        minLod = Math.min(minLod, r.lod);
        if (
          tf === '1m' &&
          !cellsShot &&
          r.lod === 2 &&
          r.rowClass === 'cells' &&
          r.barSpacing < 25
        ) {
          await page.screenshot({ path: join(SHOTS, 'cells-level-1m.png') });
          results.shots.cells = row(r, 'cells');
          perTf.push(row(r, `${tf} zellen`));
          cellsShot = true;
        }
        if (r.lod === 1) break;
      }
      perTf.push({ ...row(await readout(), `${tf} herausgezoomt`), minLod });
      let reached: Any = null;
      for (let i = 0; i < 20; i++) {
        await wheel(-240, 2);
        await idle(250);
        const r = await readout();
        if (r.lod === 3) {
          reached = row(r, `${tf} horizontal hinein → L3`);
          break;
        }
      }
      perTf.push(reached ?? row(await readout(), `${tf}: L3 nicht erreicht`));
      if (tf === '5m' || tf === '15m')
        await page.screenshot({ path: join(SHOTS, `delta-${tf}-horizontal-zoom.png`) });
    }
    results.perTimeframe = perTf;
    await page.goto(`${URL0}?sym=BTCUSDT&tf=1m&type=bidask`);
    await page.waitForFunction(() => performance.getEntriesByName('of:first-footprint').length > 0);
    await idle();
    results.shots.bidask = row(await readout(), 'bidask start');
    await page.screenshot({ path: join(SHOTS, 'default-bidask-1m.png') });
    // Manuelles R: 2 USDT (r=20) per URL, dann weit herauszoomen → Rückfall sichtbar im Hinweis
    await page.goto(`${URL0}?sym=BTCUSDT&tf=1m&type=delta&r=20`);
    await page.waitForFunction(() => performance.getEntriesByName('of:first-candles').length > 0);
    await idle(800);
    results.shots.manual = row(await readout(), 'manuell R=20');
    await page.screenshot({ path: join(SHOTS, 'manual-r-2usdt-1m.png') });
    await page.getByLabel('Zeilengröße', { exact: true }).selectOption('50');
    await idle(500);
    results.shots.manualSelect = row(await readout(), 'manuell R=50 per Auswahl');
    results.shots.manualUrl = await page.evaluate(() => location.search);
    for (let i = 0; i < 6; i++) {
      await wheel(240, 2);
      await idle(250);
    }
    results.shots.manualZoomedOut = row(await readout(), 'manuell R=50 herausgezoomt');

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
          const mids = it
            .map((b: Any) => (b.high + b.low) / 2)
            .sort((a: number, b: number) => a - b);
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
    // H-6: erster Frame nach dem Einschalten von Imbalances/Bar-VA bei Kacheln nahe der Zellgrenze
    // (alle sichtbaren Kacheln werden dabei einmal synchron berechnet)
    {
      const r = await page.evaluate(async () => {
        const c = (window as Any).__of;
        const f0 = c.rc.stats.frames;
        c.setFootprintOptions(
          {
            type: c.rc.type,
            mode: 'box',
            poc: true,
            deltaPoc: true,
            barVa: true,
            imbalance: true,
            imb: { ratio: 300, minDiff: 0, includeZero: true, horizontal: false, stack: 2 },
            stats: false,
            statsRows: ['vol'],
          },
          70,
        );
        await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
        return { ms: c.drawTimes(f0), cells: c.rc.stats.cellsDrawn, vc: c.rc.stats.vc };
      });
      results.marksFirstDraw = { maxMs: Math.max(0, ...r.ms), cells: r.cells, vc: r.vc };
      console.log('marksFirstDraw', JSON.stringify(results.marksFirstDraw));
      check(
        `erster Frame mit Marken (${r.cells} Zellen) ${results.marksFirstDraw.maxMs.toFixed(1)} ≤ 16 ms`,
        results.marksFirstDraw.maxMs <= 16,
      );
    }

    // K1: eine einzige lange Geste (horizontales Mausrad) weit über das Datenfenster hinaus; danach
    // muss die Ansicht auf Daten stehen (nicht neben dem Fenster) und die Zielzeit ungefähr stimmen.
    await page.goto(`${URL0}?sym=BTCUSDT-SYN90&tf=1m&type=delta`);
    await page.waitForFunction(() => performance.getEntriesByName('of:first-candles').length > 0);
    await idle();
    for (let i = 0; i < 8; i++) {
      await wheel(240, 2);
      await idle(150);
    }
    const before = await page.evaluate(() => {
      const c = (window as Any).__of;
      const lr = c.chart.timeScale().getVisibleLogicalRange();
      return {
        center: c.timeAtLogical((lr.from + lr.to) / 2),
        width: lr.to - lr.from,
        n: c.items.length,
      };
    });
    await scenario('long_swipe_1m', async () => {
      await page.mouse.move(cx, cy);
      for (let i = 0; i < 40; i++) {
        await page.mouse.wheel(-3000, 0);
        await page.waitForTimeout(30);
      }
      await idle(1500);
    });
    results.longSwipe = {
      before,
      after: await page.evaluate(() => {
        const c = (window as Any).__of;
        const lr = c.chart.timeScale().getVisibleLogicalRange();
        const n = c.items.length;
        return {
          center: c.timeAtLogical((lr.from + lr.to) / 2),
          from: lr.from,
          to: lr.to,
          n,
          onData: lr.to > 0 && lr.from < n - 1,
          firstItem: c.items[0]?.time,
          lastItem: c.items[n - 1]?.time,
          hint: c.readout().hint,
        };
      }),
    };
    console.log('longSwipe', JSON.stringify(results.longSwipe));
    // Review C: die Ansicht muss nach der Geste auf Daten stehen und sich wirklich bewegt haben
    check('longSwipe: Ansicht auf Daten', results.longSwipe.after.onData === true);
    check(
      'longSwipe: Ansicht bewegt',
      results.longSwipe.after.center < results.longSwipe.before.center,
    );

    // W4: gedrosselte Verbindung (20 Mbit/s, 40 ms) – Start und Pannen
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 40,
      downloadThroughput: 20e6 / 8,
      uploadThroughput: 5e6 / 8,
    });
    await page.goto(`${URL0}?sym=BTCUSDT&tf=1m&type=delta`);
    await page.waitForFunction(
      () => performance.getEntriesByName('of:first-footprint').length > 0,
      null,
      {
        timeout: 30_000,
      },
    );
    results.throttledFirstRender = await page.evaluate(() =>
      Object.fromEntries(
        performance.getEntriesByType('mark').map((m) => [m.name, +m.startTime.toFixed(1)]),
      ),
    );
    await idle();
    await scenario('pan_1m_throttled', async () => {
      for (let i = 0; i < 2; i++) {
        await drag(900, 60);
        await drag(-900, 60);
      }
      await idle(500);
    });
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });

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
  }

  // ---------------------------------------------------------------- P4: Typen, Marken, Stats-Grid
  // Alle Footprint-Typen mit Imbalances (includeZero, Stacked ab 2 → viele Marken), Delta-POC, Bar-VA,
  // Profilmodus und Stats-Grid mit allen Zeilen; gepannt und gezoomt. Budgets: Frame-Arbeit p95 ≤ 16 ms,
  // Footprint-Zeichnen p95 ≤ 8 ms, Stats-Grid-Zeichnen max ≤ 8 ms, Zellbudget, keine Long Tasks, keine
  // zusätzlichen Anfragen durch Marken/Grid (gleiche Kachel-/Bar-URLs wie ohne).
  if (process.env.PERF_ONLY !== 'profile') {
    const allRows =
      'vol,buy,sell,delta,deltaPct,cvd,aggN,aggDelta,volSec,hiRatio,loRatio,trades,maxDelta,minDelta,cotHigh,cotLow';
    for (const [type, fm] of [
      ['delta', 'box'],
      ['bidask', 'box'],
      ['volume', 'profile'],
      ['deltavol', 'profile'],
    ] as const) {
      const name = `p4_${type}_${fm}`;
      await page.goto(
        `${URL0}?sym=BTCUSDT-SYN90&tf=1m&type=${type}&fm=${fm}&dpoc=1&bva=1&imb=1&imbz=1&imbs=2&sg=1&sgr=${allRows}`,
      );
      await page.waitForFunction(
        () => performance.getEntriesByName('of:first-footprint').length > 0,
      );
      await idle(600);
      const r0 = requests.length;
      await scenario(name, async () => {
        for (let i = 0; i < 2; i++) {
          await drag(700, 40);
          await drag(-700, 40);
        }
        await wheel(240, 3, 30);
        await idle(300);
        await wheel(-240, 3, 30);
        await idle(300);
      });
      const sg = await page.evaluate(() => ({ ...(window as Any).__of.statsCtx.stats }));
      results[name].stats = sg;
      results[name].requestsDuring = requests.length - r0;
      check(
        `${name}: Frame-Arbeit p95 ${results[name].frameWork.p95} ≤ 16 ms`,
        results[name].frameWork.p95 <= 16,
      );
      check(
        `${name}: Footprint-Zeichnen p95 ${results[name].footprintDraw.p95} ≤ 8 ms`,
        results[name].footprintDraw.p95 <= 8,
      );
      check(`${name}: Stats-Zeichnen max ${sg.maxMs.toFixed(2)} ≤ 8 ms`, sg.maxMs <= 8);
      check(`${name}: keine Long Tasks`, results[name].longTasks === 0);
      if (type === 'deltavol')
        await page.screenshot({ path: join(OUT, 'p4-deltavol-profile.png') });
    }
  }

  // ---------------------------------------------------------------- P6: TPO-Ansicht
  // 10 und 60 Tage nebeneinander (Spaltenbreite = Breite / Tage), alle sichtbaren Tage geladen; dann über
  // die Tage pannen und den Preis zoomen. Budgets: Frame-Arbeit p95 ≤ 16 ms, TPO-Zeichnen p95 ≤ 8 ms,
  // keine Long Tasks.
  if (process.env.PERF_ONLY !== 'profile') {
    for (const days of [10, 60]) {
      const name = `tpo_${days}d`;
      await page.goto(`${URL0}?sym=BTCUSDT-SYN90&view=tpo&debug`);
      await page.waitForFunction(() => (window as Any).__tpo?.readout().daysLoaded > 0, null, {
        timeout: 20_000,
      });
      await page.evaluate((n: number) => {
        const t = (window as Any).__tpo;
        t.colW = (t.canvas.clientWidth - 70) / n;
        t.evaluate();
      }, days);
      for (let i = 0; i < 100; i++) {
        const r = await page.evaluate(() => (window as Any).__tpo.readout());
        if (r.inFlight === 0 && r.daysLoaded >= days) break;
        await page.waitForTimeout(150);
      }
      await idle(300);
      const f0 = await page.evaluate(() => (window as Any).__tpo.stats.frames);
      await scenario(name, async () => {
        for (let i = 0; i < 3; i++) {
          await drag(600, 30);
          await drag(-600, 30);
        }
        await wheel(240, 3, 30);
        await wheel(-240, 3, 30);
        await idle(400);
      });
      const tpo = await page.evaluate((f: number) => {
        const t = (window as Any).__tpo;
        const out: number[] = [];
        for (let i = Math.max(f, t.stats.frames - t.stats.drawMs.length); i < t.stats.frames; i++)
          out.push(t.stats.drawMs[i % t.stats.drawMs.length]);
        return { draw: out, readout: t.readout(), cells: t.stats.cells };
      }, f0);
      const draw = stats(tpo.draw);
      results[name].tpoDraw = draw;
      results[name].tpo = { ...tpo.readout, cells: tpo.cells };
      console.log(name, 'tpo', JSON.stringify({ draw, ...results[name].tpo }));
      check(
        `${name}: Frame-Arbeit p95 ${results[name].frameWork.p95} ≤ 16 ms`,
        results[name].frameWork.p95 <= 16,
      );
      check(`${name}: TPO-Zeichnen p95 ${draw.p95} ≤ 8 ms`, draw.p95 <= 8);
      check(`${name}: keine Long Tasks`, results[name].longTasks === 0);
      check(
        `${name}: ${tpo.readout.daysVisible} Tage sichtbar`,
        tpo.readout.daysVisible >= days - 1,
      );
      await page.screenshot({ path: join(OUT, `${name}.png`) });
    }
  }

  // ---------------------------------------------------------------- Volume Profile
  // Tagesprofile über 30 und ~150 Tage (herausgezoomt, 1h bzw. 4h – 4h nur, wenn angeboten; sonst 1h
  // über den ganzen Datenbereich), Pannen mit Profilen, Bereichsprofil über einen Monat. Budgets:
  // Profil-Zeichnen p95 ≤ 4 ms und max ≤ 8 ms je Frame, Frame-Arbeit p95 ≤ 16 ms, keine Long Tasks,
  // jede Profil-URL höchstens einmal je Szenario (keine Nachladeschleifen), keine Profilfehler.
  const PSYM = process.env.PERF_PROFILE_SYM ?? 'BTCUSDT-SYN90';
  const profSince = (n0: number) =>
    page.evaluate((n: number) => {
      const L = (window as Any).__of.profile;
      const out: number[] = [];
      for (let i = Math.max(n, L.counters.draws - L.drawMs.length); i < L.counters.draws; i++)
        out.push(L.drawMs[i % L.drawMs.length]);
      return out;
    }, n0);
  const profIdle = async () => {
    await idle(300);
    for (let i = 0; i < 80; i++) {
      const r = await page.evaluate(() => (window as Any).__of.profile.readout());
      if (r.inFlight === 0) break;
      await page.waitForTimeout(100);
    }
    await page.waitForTimeout(200);
  };
  /** Ansicht: die letzten `days` Tage am rechten Rand, dann Bewertung wie am Gestenende. */
  const showDays = async (days: number) => {
    await page.evaluate((d: number) => {
      const c = (window as Any).__of;
      const tf = c.readout().tf;
      const sec =
        { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 }[tf as string] ??
        3600;
      const ts = c.chart.timeScale();
      ts.applyOptions({ barSpacing: ts.width() / ((d * 86400) / sec) });
      ts.scrollToRealTime();
    }, days);
    await page.waitForTimeout(300);
    await page.evaluate(() => (window as Any).__of.reevaluate());
    await profIdle();
  };
  const profScenario = async (
    name: string,
    setup: () => Promise<void>,
    act: () => Promise<void>,
  ) => {
    const pr0 = requests.filter((u) => u.includes('/profile')).length;
    await setup();
    const n0 = await page.evaluate(() => (window as Any).__of.profile.counters.draws);
    await scenario(name, async () => {
      await act();
      await profIdle();
    });
    const draw = stats(await profSince(n0));
    const purls = requests.filter((u) => u.includes('/profile')).slice(pr0);
    const ro = await page.evaluate(() => (window as Any).__of.profile.readout());
    Object.assign(results[name], { profileDraw: draw, profileRequests: purls.length, profile: ro });
    console.log(name, 'profile', JSON.stringify({ draw, req: purls.length, ro }));
    check(
      `${name}: Profil-Zeichnen p95 ${draw.p95} ≤ 4 ms, max ${draw.max} ≤ 8 ms`,
      draw.p95 <= 4 && draw.max <= 8,
    );
    check(
      `${name}: Frame-Arbeit p95 ${results[name].frameWork.p95} ≤ 16 ms`,
      results[name].frameWork.p95 <= 16,
    );
    check(`${name}: keine Long Tasks`, results[name].longTasks === 0);
    check(`${name}: keine doppelten Profil-Anfragen`, new Set(purls).size === purls.length);
    check(`${name}: keine Profilfehler (${ro.error})`, ro.error === '');
    // schmale Tage (< 16 px) werden nach Regel ausgelassen – dann muss die Anzeige es sagen
    check(
      `${name}: Profile gezeichnet (${ro.daysDrawn}) oder sichtbar ausgelassen (${ro.daysSkipped})`,
      ro.mode === 'range' ||
        ro.daysDrawn > 0 ||
        (ro.daysSkipped > 0 && ro.note.includes('ausgelassen')),
    );
  };
  const offered = await page.evaluate(
    (s: string) => (window as Any).__of.symbols.find((x: Any) => x.name === s),
    PSYM,
  );
  const dataDays = Math.floor((offered.dataTo - offered.dataFrom) / 86_400_000);
  const tfLong = offered.tiles['4h'] || PSYM === 'BTCUSDT' ? '4h' : '1h';
  await page.goto(`${URL0}?sym=${PSYM}&tf=1h`);
  await page.waitForFunction(() => performance.getEntriesByName('of:first-candles').length > 0);
  await idle(800);
  await profScenario(
    'profile_daily_30d_1h',
    () => showDays(30),
    async () => {
      for (let i = 0; i < 2; i++) {
        await drag(700, 40);
        await drag(-700, 40);
      }
    },
  );
  await page.screenshot({ path: join(OUT, 'profile-30d-1h.png') });
  await profScenario(
    'profile_pan_1h',
    () => showDays(6),
    async () => {
      for (let i = 0; i < 6; i++) await drag(1200, 30, 12);
      for (let i = 0; i < 6; i++) await drag(-1200, 30, 12);
    },
  );
  await page.goto(`${URL0}?sym=${PSYM}&tf=${tfLong}`);
  await page.waitForFunction(() => performance.getEntriesByName('of:first-candles').length > 0);
  await idle(800);
  const longDays = Math.min(150, dataDays);
  await profScenario(
    `profile_daily_${longDays}d_${tfLong}`,
    () => showDays(longDays),
    async () => {
      await drag(500, 30);
      await drag(-500, 30);
    },
  );
  await page.screenshot({ path: join(OUT, `profile-${longDays}d-${tfLong}.png`) });
  // Bereichsprofil über einen Monat (endet 2 Tage vor Datenende)
  const rTo = Math.floor((offered.dataTo - 2 * 86_400_000) / 60_000) * 60_000;
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 16);
  await page.goto(
    `${URL0}?sym=${PSYM}&tf=1h&pm=range&pf=${iso(rTo - 30 * 86_400_000)}&pt=${iso(rTo)}`,
  );
  await page.waitForFunction(() => performance.getEntriesByName('of:first-candles').length > 0);
  await idle(800);
  await profScenario(
    'profile_range_month_1h',
    () => showDays(34),
    async () => {
      await drag(400, 30);
      await drag(-400, 30);
    },
  );
  results.profileRangeSummary = await page.evaluate(() => (window as Any).__of.profile.summary());
  await page.screenshot({ path: join(OUT, 'profile-range-month.png') });
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
  const loadErr = (e: string) => e.includes('status of 422');
  let skip = profile422;
  const pageErrors = errors.filter((e) => !(loadErr(e) && skip-- > 0));
  results.profile422 = profile422;
  results.errors = pageErrors;
  // über alle Szenarien (jede Seite hat eigene Zähler)
  const maxVc = Math.max(
    0,
    ...Object.values(results).map((v: Any) =>
      v && typeof v.maxVcWithCells === 'number' ? v.maxVcWithCells : 0,
    ),
  );
  results.cellBudget.maxVcAllScenarios = maxVc;
  check(`Zellbudget nie überschritten (max ${maxVc})`, maxVc <= 25_000);
  check(
    'keine Long Tasks',
    Object.values(results).every((v: Any) => !v || v.longTasks === undefined || v.longTasks === 0),
  );
  check(`keine Seitenfehler (${pageErrors.length})`, pageErrors.length === 0);
  results.failures = failures;
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
  if (failures.length > 0) process.exitCode = 1;
}

await main();
// (Exit-Code ≠ 0, wenn eine Prüfung fehlschlug; siehe perf-results.json → failures)
