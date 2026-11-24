// Benchmark der API auf echten Daten (nur lesend, Datenbank aus .env, Rolle of_api). Startet die API
// selbst als Kindprozess auf einem freien Port und misst über HTTP (Loopback, gzip wie ein Browser):
//   1. „kalt": erster Zugriff je URL nach dem API-Start (leerer API-Cache, neue DB-Verbindungen;
//      Postgres-shared_buffers und der Page-Cache des Betriebssystems lassen sich hier nicht leeren)
//   2. Cache-Treffer: dieselben URLs noch einmal (nur finale Antworten liegen im Cache)
//   3. „warm": zweite API-Instanz ohne Antwort-Cache, dieselben URLs (Daten jetzt im DB-Cache)
//   4. 20 gleichzeitige gemischte Anfragen (ohne Antwort-Cache)
//   5. Startzeit (Katalog), Speicher (RSS) der API
//   npm run bench -w @orderflow/api            (Ergebnis: apps/api/bench/results.json + Tabelle)
import { spawn, type ChildProcess } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SYM = process.env.BENCH_SYM ?? 'BTCUSDT';
const DAY = 86_400_000;
const TF_SEC: Record<string, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '4h': 14_400,
  '1d': 86_400,
};

interface Api {
  url: string;
  proc: ChildProcess;
  startMs: number;
}

async function spawnApi(port: number, env: Record<string, string>): Promise<Api> {
  const t0 = performance.now();
  const proc = spawn(process.execPath, [join(here, '..', 'src', 'main.ts')], {
    env: { ...process.env, OF_API_PORT: String(port), OF_LOG_LEVEL: 'warn', ...env },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const url = `http://127.0.0.1:${port}`;
  for (;;) {
    try {
      const r = await fetch(`${url}/api/v1/symbols`);
      if (r.ok) break;
    } catch {
      /* noch nicht bereit */
    }
    if (proc.exitCode !== null) throw new Error('API beendet');
    await new Promise((r) => setTimeout(r, 50));
  }
  return { url, proc, startMs: performance.now() - t0 };
}

async function stop(api: Api): Promise<void> {
  api.proc.kill('SIGTERM');
  await new Promise((r) => api.proc.once('exit', r));
}

interface Sample {
  ms: number;
  status: number;
  raw: number;
  gz: number;
  rowsEst: number | null;
  src: string | null;
  cache: string | null;
}

async function measure(base: string, path: string): Promise<Sample> {
  const t0 = performance.now();
  const r = await fetch(base + path, { headers: { 'Accept-Encoding': 'gzip' } });
  const body = await r.arrayBuffer();
  const ms = performance.now() - t0;
  const enc = r.headers.get('content-encoding');
  const len = Number(r.headers.get('content-length') ?? body.byteLength);
  return {
    ms,
    status: r.status,
    raw: body.byteLength,
    gz: enc === 'gzip' ? len : body.byteLength,
    rowsEst: r.headers.has('x-rows-estimate') ? Number(r.headers.get('x-rows-estimate')) : null,
    src: r.headers.get('x-source'),
    cache: r.headers.get('x-cache'),
  };
}

function q(a: number[], p: number): number {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]!;
}
const r1 = (x: number) => Math.round(x * 10) / 10;

function summarize(samples: Sample[]) {
  const ms = samples.map((s) => s.ms);
  return {
    n: samples.length,
    p50: r1(q(ms, 0.5)),
    p95: r1(q(ms, 0.95)),
    max: r1(Math.max(...ms)),
    rawKB: r1(
      q(
        samples.map((s) => s.raw),
        0.5,
      ) / 1024,
    ),
    rawKBmax: r1(Math.max(...samples.map((s) => s.raw)) / 1024),
    gzKB: r1(
      q(
        samples.map((s) => s.gz),
        0.5,
      ) / 1024,
    ),
    rowsEst: q(
      samples.map((s) => s.rowsEst ?? 0),
      0.5,
    ),
    rowsEstMax: Math.max(...samples.map((s) => s.rowsEst ?? 0)),
    src: [...new Set(samples.map((s) => s.src))].join(','),
    errors: samples.filter((s) => s.status !== 200).length,
  };
}

/** Deterministische Zufallszahlen. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

async function main(): Promise<void> {
  const port = Number(process.env.BENCH_PORT ?? 8790);
  const a = await spawnApi(port, {});
  const symbols = (await (await fetch(`${a.url}/api/v1/symbols`)).json()) as {
    symbols: {
      name: string;
      dataFrom: number;
      dataTo: number;
      tileConfigVersion: number;
      tiles: Record<string, Record<string, number>>;
    }[];
  };
  const s = symbols.symbols.find((x) => x.name === SYM)!;
  const rnd = rng(42);
  const groups: { name: string; kind: string; paths: string[] }[] = [];
  // Footprint-Kacheln: feinste angebotene R, typisches Auto-R des Clients, gröbste R
  const AUTO: Record<string, number> = {
    '1m': 200,
    '5m': 500,
    '15m': 1000,
    '1h': 2000,
    '4h': 5000,
    '1d': 10_000,
  };
  for (const tf of Object.keys(TF_SEC)) {
    const offered = Object.keys(s.tiles[tf] ?? {})
      .map(Number)
      .sort((x, y) => x - y);
    if (offered.length === 0) continue;
    const pick = [...new Set([offered[0]!, AUTO[tf]!, offered[offered.length - 1]!])].filter((R) =>
      offered.includes(R),
    );
    for (const R of pick) {
      const n = s.tiles[tf]![String(R)]!;
      const span = n * TF_SEC[tf]! * 1000;
      const k0 = Math.floor(s.dataFrom / span);
      const k1 = Math.floor((s.dataTo - 1) / span);
      const ks = new Set<number>();
      while (ks.size < Math.min(20, k1 - k0 + 1)) ks.add(k0 + Math.floor(rnd() * (k1 - k0 + 1)));
      groups.push({
        name: `footprint ${tf} R=${R} (n=${n})`,
        kind: 'footprint',
        paths: [...ks].map(
          (k) =>
            `/api/v1/footprint?sym=${SYM}&tf=${tf}&R=${R}&tile=${k}&cfg=${s.tileConfigVersion}`,
        ),
      });
    }
  }
  // Bar-Abschnitte zu 1 000 Bars
  for (const tf of ['1m', '5m', '15m', '1h', '4h', '1d']) {
    const span = 1000 * TF_SEC[tf]! * 1000;
    const c0 = Math.floor(s.dataFrom / span);
    const c1 = Math.floor((s.dataTo - 1) / span);
    const cs = new Set<number>();
    while (cs.size < Math.min(20, c1 - c0 + 1)) cs.add(c0 + Math.floor(rnd() * (c1 - c0 + 1)));
    groups.push({
      name: `bars ${tf} (1000)`,
      kind: 'bars',
      paths: [...cs].map(
        (c) => `/api/v1/bars?sym=${SYM}&tf=${tf}&from=${c * span}&to=${(c + 1) * span}`,
      ),
    });
  }
  // Profile: Auto-R ≈ 120 Zeilen (Range) bzw. ≈ 60 je Tag (§6.3); zusätzlich Feinstfall R = 5 (fp_1m)
  const days = (s.dataTo - s.dataFrom) / DAY;
  const dayStarts = Array.from(
    { length: 10 },
    () => s.dataFrom + Math.floor(rnd() * (days - 1)) * DAY,
  );
  const unaligned = (d: number) => d + (7 * 60 + 13) * 60_000;
  groups.push({
    name: 'profile 1 Tag, R=500 (Auto)',
    kind: 'profile',
    paths: dayStarts.map((d) => `/api/v1/profile?sym=${SYM}&from=${d}&to=${d + DAY}&R=500`),
  });
  groups.push({
    name: 'profile 1 Tag unausgerichtet (07:13…), R=500',
    kind: 'profile',
    paths: dayStarts.map(
      (d) => `/api/v1/profile?sym=${SYM}&from=${unaligned(d)}&to=${unaligned(d) + DAY}&R=500`,
    ),
  });
  groups.push({
    name: 'profile 1 Tag, R=5 (fp_1m, Feinstfall)',
    kind: 'profile',
    paths: dayStarts
      .slice(0, 5)
      .map((d) => `/api/v1/profile?sym=${SYM}&from=${d}&to=${d + DAY}&R=5`),
  });
  const months = Array.from({ length: 5 }, (_, i) => s.dataFrom + (5 + i * 25) * DAY);
  groups.push({
    name: 'profile 30 Tage unausgerichtet, R=2000 (Auto)',
    kind: 'profile',
    paths: months.map(
      (d) => `/api/v1/profile?sym=${SYM}&from=${unaligned(d)}&to=${unaligned(d) + 30 * DAY}&R=2000`,
    ),
  });
  groups.push({
    name: `profile gesamte Historie (${days} Tage), R=5000 (Auto)`,
    kind: 'profile',
    paths: [
      `/api/v1/profile?sym=${SYM}&from=${s.dataFrom}&to=${s.dataTo}&R=5000`,
      `/api/v1/profile?sym=${SYM}&from=${unaligned(s.dataFrom)}&to=${s.dataTo - 60_000}&R=5000`,
      `/api/v1/profile?sym=${SYM}&from=${s.dataFrom}&to=${s.dataTo}&R=1000`,
    ],
  });
  groups.push({
    name: 'profiles/daily 30 Tage, R=500',
    kind: 'daily',
    paths: months.map(
      (d) => `/api/v1/profiles/daily?sym=${SYM}&from=${d}&to=${d + 30 * DAY}&R=500`,
    ),
  });
  groups.push({
    name: 'profiles/daily 30 Tage offsetH=-7, R=500',
    kind: 'daily',
    paths: months.map(
      (d) =>
        `/api/v1/profiles/daily?sym=${SYM}&from=${d - 7 * 3_600_000}&to=${d + 30 * DAY - 7 * 3_600_000}&R=500&offsetH=-7`,
    ),
  });

  const out: Record<string, unknown>[] = [];
  const cold = new Map<string, Sample[]>();
  for (const g of groups) {
    const ss: Sample[] = [];
    for (const p of g.paths) ss.push(await measure(a.url, p));
    cold.set(g.name, ss);
  }
  const hit = new Map<string, Sample[]>();
  for (const g of groups) {
    const ss: Sample[] = [];
    for (const p of g.paths) ss.push(await measure(a.url, p));
    hit.set(g.name, ss);
  }
  const healthA = (await (await fetch(`${a.url}/api/v1/health`)).json()) as Record<string, unknown>;
  await stop(a);

  const b = await spawnApi(port + 1, { OF_API_CACHE_MB: '0' });
  const warm = new Map<string, Sample[]>();
  for (const g of groups) {
    const ss: Sample[] = [];
    for (const p of g.paths) ss.push(await measure(b.url, p));
    warm.set(g.name, ss);
  }
  // 20 gleichzeitige gemischte Anfragen (ohne Cache), dreimal
  const mixed = groups.flatMap((g) => g.paths.slice(0, 2));
  const conc: Sample[] = [];
  const wall: number[] = [];
  for (let rep = 0; rep < 3; rep++) {
    const pick = Array.from({ length: 20 }, () => mixed[Math.floor(rnd() * mixed.length)]!);
    const t0 = performance.now();
    conc.push(...(await Promise.all(pick.map((p) => measure(b.url, p)))));
    wall.push(performance.now() - t0);
  }
  const healthB = (await (await fetch(`${b.url}/api/v1/health`)).json()) as Record<string, unknown>;
  await stop(b);

  for (const g of groups) {
    out.push({
      name: g.name,
      kind: g.kind,
      cold: summarize(cold.get(g.name)!),
      hit: summarize(hit.get(g.name)!),
      warm: summarize(warm.get(g.name)!),
    });
  }
  const result = {
    at: new Date().toISOString(),
    symbol: SYM,
    dataFrom: new Date(s.dataFrom).toISOString(),
    dataTo: new Date(s.dataTo).toISOString(),
    startupMs: { cold: r1(a.startMs), second: r1(b.startMs) },
    memory: {
      afterColdAndHits: healthA.memory,
      afterWarmAndConcurrent: healthB.memory,
      cache: healthA.cache,
    },
    concurrent20: { ...summarize(conc), wallMs: wall.map(r1) },
    groups: out,
  };
  await writeFile(join(here, 'results.json'), JSON.stringify(result, null, 2));
  const line = (x: Record<string, unknown>) => {
    const c = x.cold as ReturnType<typeof summarize>;
    const w = x.warm as ReturnType<typeof summarize>;
    const h = x.hit as ReturnType<typeof summarize>;
    return `| ${String(x.name)} | ${c.p50} / ${c.p95} / ${c.max} | ${w.p50} / ${w.p95} / ${w.max} | ${h.p50} / ${h.p95} | ${w.rawKB} (max ${w.rawKBmax}) | ${w.gzKB} | ${w.rowsEst} (max ${w.rowsEstMax}) | ${w.src} | ${c.errors + w.errors} |`;
  };
  console.log(
    '| Anfrage | kalt p50/p95/max ms | warm p50/p95/max ms | Cache-Treffer p50/p95 | roh kB p50 | gzip kB p50 | Quellzeilen (geschätzt) | Quelle | Fehler |',
  );
  console.log('|---|---|---|---|---|---|---|---|---|');
  for (const x of out) console.log(line(x));
  console.log(`\n20 gleichzeitig: ${JSON.stringify(result.concurrent20)}`);
  console.log(
    `Start: ${JSON.stringify(result.startupMs)} ms; Speicher: ${JSON.stringify(result.memory)}`,
  );
}

await main();
