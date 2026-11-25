<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { APP_TITLE, CHARTS_ATTRIBUTION, CHARTS_URL } from './app-info.ts';
  import { ChartController, rowLabel, type Readout } from './lib/controller.ts';
  import { exactDecimal } from './lib/format.ts';
  import type { ColorMode, ColorScope, FootprintType, SymbolInfo } from './lib/types.ts';
  import type { ProfileReadout, RangeSummary } from './lib/profile/layer.ts';
  import {
    footprintParamsQuery,
    parseFootprintParams,
    type FootprintOptions,
  } from './lib/footprint-options.ts';
  import { STAT_ROWS, type StatRow } from './lib/stats-grid.ts';
  import {
    parseProfileParams,
    profileParamsQuery,
    type ProfileMode,
    type ProfileParams,
    type ProfileView,
  } from './lib/profile/model.ts';

  // Nur UI-Einstellungen sind reaktiv (KONZEPT §7.3); Chartdaten liegen im Controller.
  const params = new URLSearchParams(location.search);
  let sym = $state(params.get('sym') ?? 'BTCUSDT');
  // Zeitrahmen kommen aus /symbols (nur angebotene); bis dahin der aus der URL
  let tf = $state(params.get('tf') ?? '1m');
  let timeframes = $state.raw<string[]>([]);
  let dataTo = $state(0);
  const atParam = Number(params.get('at'));
  // Diagnosezeile: in der Entwicklung offen, sonst eingeklappt (für Fehlerberichte aufklappbar)
  let diagOpen = $state(import.meta.env.DEV || params.has('debug'));
  // Footprint-Typ, Marken, Stats-Grid (URL: type, fm, poc, dpoc, bva, imb*, sg, sgr)
  let fpo = $state<FootprintOptions>(parseFootprintParams(params));
  const type = $derived(fpo.type);
  // Zeilengröße: 'auto' oder Ticks (URL-Parameter r, z. B. r=50 = 5 USDT bei BTC)
  const rParam = params.get('r');
  // nur positive ganze Ticks; alles andere (z. B. r=0) = Auto
  let rMode = $state<string>(rParam && /^[1-9]\d*$/.test(rParam) ? rParam : 'auto');
  let colorMode = $state<ColorMode>('gradient');
  let colorScope = $state<ColorScope>('visible');
  let symbols = $state.raw<string[]>([]);
  let rOptions = $state.raw<number[]>([]);
  let symInfo = $state.raw<SymbolInfo | null>(null);
  let ro = $state.raw<Readout | null>(null);
  let error = $state('');
  // Volume-Profile-Einstellungen (URL: pm, pv, va, oh, pr, pe, pl, pf/pt)
  let prof = $state<ProfileParams>(parseProfileParams(params));
  let pro = $state.raw<ProfileReadout | null>(null);
  let summary = $state.raw<RangeSummary | null>(null);
  let profLadder = $state.raw<number[]>([]);

  let el: HTMLDivElement;
  // Hover-Text: höchstens einmal je Animation-Frame gesetzt (Controller bündelt per rAF)
  let hover = $state('');
  let ready = $state(false);
  let ctl: ChartController | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let removeKey: (() => void) | null = null;

  onMount(() => {
    ctl = new ChartController(el);
    if (import.meta.env.DEV || params.has('debug')) {
      (window as unknown as { __of: ChartController }).__of = ctl;
    }
    ctl.setType(fpo.type);
    applyProfile();
    applyFootprint();
    ctl.onProfile = () => {
      readProfile();
      syncUrl();
    };
    ctl.profile.onChange = () => {
      summary = ctl?.profile.summary() ?? null;
    };
    // Esc bricht die Bereichsauswahl ab
    // H-7: Menüs (<details>) schließen bei Esc und Klick außerhalb
    const closeMenus = (except?: Element | null) => {
      for (const d of document.querySelectorAll('details.menu[open]'))
        if (d !== except) d.removeAttribute('open');
    };
    const onDown = (e: PointerEvent) =>
      closeMenus((e.target as Element | null)?.closest('details.menu') ?? null);
    window.addEventListener('pointerdown', onDown);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeMenus();
      if (e.key === 'Escape' && ctl?.profile.selecting) {
        ctl.profile.cancelSelect();
        pro = ctl.profile.readout();
      }
    };
    window.addEventListener('keydown', onKey);
    removeKey = () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown);
    };
    ctl.onHover = (t) => (hover = t);
    ctl.onSymbols = () => refreshLists();
    // Start; ist die API (noch) nicht erreichbar, sichtbar melden und alle 10 s erneut versuchen
    const start = (): void => {
      if (!ctl) return;
      ctl
        .init(
          sym,
          tf,
          rMode === 'auto' ? 'auto' : Number(rMode),
          params.has('at') ? atParam : undefined, // Prüfung/Klemmung in parseAt
        )
        .then(() => {
          error = '';
          sym = ctl!.readout().sym;
          tf = ctl!.readout().tf;
          refreshLists();
          ready = true;
          // Bereich aus der URL erst mit bekanntem Datenbereich setzen
          if (prof.range && !ctl!.profile.range) {
            if (!ctl!.profile.setRange(prof.range, prof.rangeNote)) readProfile();
          }
          syncUrl();
        })
        .catch((e: unknown) => {
          error = `${e instanceof Error ? e.message : String(e)} – neuer Versuch in 10 s`;
          retryTimer = setTimeout(start, 10_000);
        });
    };
    start();
    // Anzeige höchstens 4×/s aktualisieren (keine Kopplung an Frames).
    timer = setInterval(() => {
      if (!ctl) return;
      ro = ctl.readout();
      pro = ctl.profile.readout();
      // Auswahl, URL und Controller konsistent halten: angezeigt wird das wirksame R
      const eff = ro.rAuto ? 'auto' : String(ro.R);
      if (ready && eff !== rMode && (ro.rAuto || rOptions.includes(ro.R))) {
        rMode = eff;
        syncUrl();
      }
    }, 250);
  });

  onDestroy(() => {
    if (timer) clearInterval(timer);
    if (retryTimer) clearTimeout(retryTimer);
    removeKey?.();
    ctl?.destroy();
  });

  /** Symbol-/Zeitrahmen-/R-Listen und Datenstand aus dem Controller (nach Start und Aktualisierung). */
  function refreshLists(): void {
    if (!ctl) return;
    symbols = ctl.symbols.map((s) => s.name);
    symInfo = ctl.symbols.find((s) => s.name === sym) ?? null;
    timeframes = ctl.timeframes();
    rOptions = ctl.availableR(tf);
    dataTo = ctl.dataTo();
    profLadder = ctl.profile.ladder();
  }

  /** UI-Zustand → Profilschicht. */
  function applyProfile(): void {
    if (!ctl) return;
    const p = ctl.profile;
    p.mode = prof.mode;
    p.view = prof.view;
    p.va = prof.va;
    p.offsetH = prof.offsetH;
    p.manualR = prof.R;
    p.extend = prof.extend;
    p.showVa = prof.showVa;
    p.scaleMode = prof.scale;
    if (!prof.range && p.range) p.clearRange();
    p.changed();
    pro = p.readout();
    summary = p.summary();
  }
  /** Profilschicht → UI-Zustand (nach Bereichsauswahl im Chart). */
  function readProfile(): void {
    if (!ctl) return;
    const p = ctl.profile;
    prof = { ...prof, mode: p.mode, range: p.range };
    pro = p.readout();
    summary = p.summary();
  }
  function setProf(patch: Partial<ProfileParams>): void {
    prof = { ...prof, ...patch };
    applyProfile();
    applyFootprint(); // VA % und Tagesgrenze gelten auch für Bar-VA und Stats-CVD
    syncUrl();
  }
  function applyFootprint(): void {
    if (!ctl) return;
    ctl.setFootprintOptions($state.snapshot(fpo) as FootprintOptions, prof.va);
    ctl.refreshStats();
  }
  function setFp(patch: Partial<FootprintOptions>): void {
    fpo = { ...fpo, ...patch };
    applyFootprint();
    syncUrl();
  }
  function setImb(patch: Partial<FootprintOptions['imb']>): void {
    setFp({ imb: { ...fpo.imb, ...patch } });
  }
  function toggleStatRow(r: StatRow): void {
    const has = fpo.statsRows.includes(r);
    const rows = STAT_ROWS.map((x) => x.id).filter((x) =>
      x === r ? !has : fpo.statsRows.includes(x),
    );
    if (rows.length > 0) setFp({ statsRows: rows });
  }
  const TYPES: [FootprintType, string][] = [
    ['delta', 'Delta'],
    ['bidask', 'Bid×Ask'],
    ['volume', 'Volume'],
    ['deltavol', 'Δ + Vol'],
  ];
  const RATIOS = [150, 200, 250, 300, 400, 500];
  const MINDIFF_BASE = [0, 0.1, 0.5, 1, 5, 10];
  // H-8: Werte aus der URL, die nicht in der Liste stehen, als eigene Option zeigen
  const withValue = (list: number[], v: number) =>
    list.includes(v) ? list : [...list, v].sort((a, b) => a - b);
  const ratioOptions = $derived(withValue(RATIOS, fpo.imb.ratio));
  const minDiffOptions = $derived(
    withValue(
      MINDIFF_BASE.map((m) => Math.round(m * 10 ** (symInfo?.qtyDecimals ?? 3))),
      fpo.imb.minDiff,
    ),
  );
  const stackOptions = $derived(withValue([2, 3, 4, 5, 6], fpo.imb.stack));

  function syncUrl(): void {
    const q = `?sym=${encodeURIComponent(sym)}&tf=${tf}&type=${type}&r=${rMode}${footprintParamsQuery(fpo)}${profileParamsQuery(prof)}${params.has('debug') ? '&debug' : ''}`;
    history.replaceState(null, '', q);
    document.title = `${sym} ${tf} · ${APP_TITLE}`;
  }

  /** „Daten bis": letzte volle Minute vor dataTo (exklusiv), UTC. */
  const fmtUtc = (ms: number) =>
    ms > 0 ? new Date(ms - 60_000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '';

  function chooseTf(v: string): void {
    if (!ready) return; // H3: vor init() keine Umschaltung
    tf = v;
    ctl?.setTimeframe(v); // manuelles R bleibt, falls für v verfügbar (sonst nächstes, mit Hinweis)
    rOptions = ctl?.availableR(v) ?? [];
    syncUrl();
  }
  function chooseSym(v: string): void {
    if (!ready) return;
    sym = v;
    ctl?.setSymbol(v);
    if (ctl) tf = ctl.readout().tf;
    readProfile(); // Bereich gehört zum alten Symbol
    prof = { ...prof, R: null };
    if (ctl) ctl.profile.manualR = null;
    refreshLists();
    syncUrl();
  }
  function chooseType(v: FootprintType): void {
    setFp({ type: v });
  }
  function chooseR(v: string): void {
    if (!ready) return;
    rMode = v;
    ctl?.setRowMode(v === 'auto' ? 'auto' : Number(v));
    syncUrl();
  }
  const label = (r: number) => (symInfo ? rowLabel(r, symInfo) : `${r} Ticks`);
  const MODES: [ProfileMode, string][] = [
    ['off', 'aus'],
    ['daily', 'Tage'],
    ['range', 'Bereich'],
    ['both', 'Tage + Bereich'],
  ];
  const VIEWS: [ProfileView, string][] = [
    ['total', 'Total'],
    ['buysell', 'Buy/Sell'],
    ['delta', 'Delta'],
  ];
  // −11…+12: −12 und +12 ergäben dieselben Tagesgrenzen (12:00 UTC)
  const OFFSETS = Array.from({ length: 24 }, (_, i) => i - 11);
  function startSelect(): void {
    if (!ctl || !ready) return;
    if (ctl.profile.selecting) ctl.profile.cancelSelect();
    else ctl.profile.startSelect();
    pro = ctl.profile.readout();
  }
  function dismissProfileError(): void {
    ctl?.profile.dismissError();
    if (ctl) pro = ctl.profile.readout();
  }
  function clearRange(): void {
    ctl?.profile.clearRange();
    readProfile();
    syncUrl();
  }
</script>

<main>
  <header class="toolbar">
    <strong>{APP_TITLE}</strong>
    {#if symbols.length > 1}
      <select
        class="sym-select"
        aria-label="Symbol"
        value={sym}
        onchange={(e) => chooseSym(e.currentTarget.value)}
      >
        {#each symbols as s (s)}<option value={s}>{s}</option>{/each}
      </select>
    {:else}
      <span class="sym">{sym}</span>
    {/if}
    <div class="group" role="group" aria-label="Zeitrahmen">
      {#each timeframes as t (t)}
        <button class:active={tf === t} onclick={() => chooseTf(t)}>{t}</button>
      {/each}
    </div>
    <div class="group" role="group" aria-label="Footprint-Typ">
      {#each TYPES as [t, l] (t)}
        <button class:active={type === t} aria-pressed={type === t} onclick={() => chooseType(t)}>
          {l}
        </button>
      {/each}
    </div>
    <select
      aria-label="Zeilengröße"
      title="Zeilengröße des Footprints"
      value={rMode}
      onchange={(e) => chooseR(e.currentTarget.value)}
    >
      <option value="auto">R auto{ro && ro.rAuto ? ` (${ro.rLabel})` : ''}</option>
      {#each rOptions as r (r)}<option value={String(r)}>R {label(r)}</option>{/each}
    </select>
    <div class="group" role="group" aria-label="Footprint-Marken">
      <button
        class:active={fpo.imbalance}
        aria-pressed={fpo.imbalance}
        title="Imbalances (Markierung am Zellrand) und Stacked Imbalances (Zone, nach rechts projiziert)"
        onclick={() => setFp({ imbalance: !fpo.imbalance })}
      >
        Imbalance
      </button>
      <button
        class:active={fpo.stats}
        aria-pressed={fpo.stats}
        title="Stats-Grid unter dem Chart (an den Bars ausgerichtet)"
        onclick={() => setFp({ stats: !fpo.stats })}
      >
        Stats
      </button>
      <details class="menu">
        <summary>Footprint ▾</summary>
        <div class="panel">
          <div class="group" role="group" aria-label="Marken je Bar">
            <button
              class:active={fpo.mode === 'profile'}
              aria-pressed={fpo.mode === 'profile'}
              title="Profil im Footprint: Balken je Zeile (Länge ∝ Wert / Maximum im Bar) statt gefärbter Box"
              onclick={() => setFp({ mode: fpo.mode === 'profile' ? 'box' : 'profile' })}
            >
              Balken
            </button>
            <button
              class:active={fpo.poc}
              aria-pressed={fpo.poc}
              title="POC je Bar (gelber Rahmen)"
              onclick={() => setFp({ poc: !fpo.poc })}
            >
              POC
            </button>
            <button
              class:active={fpo.deltaPoc}
              aria-pressed={fpo.deltaPoc}
              title="Delta-POC je Bar: Zeile mit größtem |Delta|, Rahmen türkis (+) bzw. orange (−)"
              onclick={() => setFp({ deltaPoc: !fpo.deltaPoc })}
            >
              Δ-POC
            </button>
            <button
              class:active={fpo.barVa}
              aria-pressed={fpo.barVa}
              title="Value Area je Bar (VA-% wie beim Profil) als schmaler Balken links der Spalte (ab 12 px Bar-Abstand)"
              onclick={() => setFp({ barVa: !fpo.barVa })}
            >
              Bar-VA
            </button>
          </div>
          <label>
            Farbe
            <select
              aria-label="Farbmodus"
              value={colorMode}
              onchange={(e) => {
                colorMode = e.currentTarget.value as ColorMode;
                ctl?.setColorMode(colorMode);
              }}
            >
              <option value="gradient">Verlauf</option>
              <option value="fixed">fest</option>
              <option value="off">aus</option>
            </select>
            <select
              aria-label="Farbbereich"
              value={colorScope}
              onchange={(e) => {
                colorScope = e.currentTarget.value as ColorScope;
                ctl?.setColorScope(colorScope);
              }}
            >
              <option value="visible">sichtbar</option>
              <option value="bar">je Bar</option>
            </select>
          </label>
          <b>Imbalance</b>
          <label>
            Faktor
            <select
              aria-label="Imbalance-Faktor"
              value={String(fpo.imb.ratio)}
              onchange={(e) => setImb({ ratio: Number(e.currentTarget.value) })}
            >
              {#each ratioOptions as r (r)}<option value={String(r)}>{r} %</option>{/each}
            </select>
          </label>
          <label>
            Mindestdifferenz
            <select
              aria-label="Imbalance-Mindestdifferenz"
              value={String(fpo.imb.minDiff)}
              onchange={(e) => setImb({ minDiff: Number(e.currentTarget.value) })}
            >
              {#each minDiffOptions as m (m)}<option value={String(m)}>
                  {exactDecimal(m, symInfo?.qtyDecimals ?? 3)}
                  {sym.replace(/USDT$/, '')}
                </option>{/each}
            </select>
          </label>
          <label>
            Stacked ab
            <select
              aria-label="Stacked-Länge"
              value={String(fpo.imb.stack)}
              onchange={(e) => setImb({ stack: Number(e.currentTarget.value) })}
            >
              {#each stackOptions as n (n)}<option value={String(n)}>{n} Zeilen</option>{/each}
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={fpo.imb.includeZero}
              onchange={(e) => setImb({ includeZero: e.currentTarget.checked })}
            /> Gegenseite 0 zählt
          </label>
          <label>
            <input
              type="checkbox"
              checked={fpo.imb.horizontal}
              onchange={(e) => setImb({ horizontal: e.currentTarget.checked })}
            /> horizontal (statt diagonal)
          </label>
          <b>Stats-Zeilen</b>
          {#each STAT_ROWS as r (r.id)}
            <label title={r.title}>
              <input
                type="checkbox"
                checked={fpo.statsRows.includes(r.id)}
                onchange={() => toggleStatRow(r.id)}
              />
              {r.label}{r.column ? ` (API: ${r.column})` : ''}
            </label>
          {/each}
        </div>
      </details>
    </div>
    <div class="group" role="group" aria-label="Volumenprofil">
      {#each VIEWS as [v, t] (v)}
        <button
          class:active={prof.mode !== 'off' && prof.view === v}
          aria-pressed={prof.mode !== 'off' && prof.view === v}
          title="Volumenprofil: Ansicht {t}"
          onclick={() => setProf(prof.mode === 'off' ? { view: v, mode: 'daily' } : { view: v })}
        >
          {t}
        </button>
      {/each}
      <button
        class:active={pro?.selecting}
        aria-pressed={pro?.selecting ?? false}
        title="Zwei Klicks: Anfang und Ende (Bar-genau, auf Minuten); Esc bricht ab"
        onclick={startSelect}
      >
        Bereich
      </button>
      {#if prof.range}<button title="Bereichsprofil entfernen" onclick={clearRange}>✕</button>{/if}
      <details class="menu right">
        <summary>Profil ▾</summary>
        <div class="panel">
          <select
            aria-label="Profilmodus"
            value={prof.mode}
            onchange={(e) => setProf({ mode: e.currentTarget.value as ProfileMode })}
          >
            {#each MODES as [m, t] (m)}<option value={m}>Profil: {t}</option>{/each}
          </select>
          <div class="group" role="group" aria-label="Profiloptionen">
            <button
              class:active={prof.showVa}
              aria-pressed={prof.showVa}
              title="Value Area (Fläche + VAH/VAL)"
              onclick={() => setProf({ showVa: !prof.showVa })}
            >
              VA
            </button>
            <button
              class:active={prof.extend}
              aria-pressed={prof.extend}
              title="POC/VAH/VAL nach rechts verlängern, bis der Preis sie erreicht (naked)"
              onclick={() => setProf({ extend: !prof.extend })}
            >
              verlängern
            </button>
            <button
              class:active={prof.scale === 'common'}
              aria-pressed={prof.scale === 'common'}
              title="Tagesprofile: gemeinsame Skala über die sichtbaren Tage statt je Profil"
              onclick={() => setProf({ scale: prof.scale === 'common' ? 'profile' : 'common' })}
            >
              gemeinsame Skala
            </button>
          </div>
          <label>
            VA
            <select
              aria-label="Value-Area-Anteil"
              value={String(prof.va)}
              onchange={(e) => setProf({ va: Number(e.currentTarget.value) })}
            >
              {#each [60, 68, 70, 80, 90] as v (v)}<option value={String(v)}>{v} %</option>{/each}
            </select>
          </label>
          <label>
            Tag ab
            <select
              aria-label="Tagesbeginn (UTC-Offset in Stunden)"
              value={String(prof.offsetH)}
              onchange={(e) => setProf({ offsetH: Number(e.currentTarget.value) })}
            >
              {#each OFFSETS as o (o)}<option value={String(o)}>
                  {String((o + 24) % 24).padStart(2, '0')}:00 UTC
                </option>{/each}
            </select>
          </label>
          <label>
            Profilzeile
            <select
              aria-label="Profil-Zeilengröße"
              value={prof.R === null ? 'auto' : String(prof.R)}
              onchange={(e) =>
                setProf({
                  R: e.currentTarget.value === 'auto' ? null : Number(e.currentTarget.value),
                })}
            >
              <option value="auto">
                Auto{pro && pro.rAuto && pro.rLabel ? ` (${pro.rLabel})` : ''}
              </option>
              {#each profLadder as r (r)}<option value={String(r)}>{label(r)}</option>{/each}
            </select>
          </label>
        </div>
      </details>
    </div>
  </header>

  <div class="chart" bind:this={el}>
    {#if (ro && ro.blocked) || error}
      <!-- A: nicht zoombedingte Gründe ohne Footprint dauerhaft sichtbar -->
      <div class="banner" role="alert">{error || ro?.blocked}</div>
    {/if}
  </div>

  {#if summary}
    <div class="summary" data-testid="range-summary">
      <b>Bereich</b>
      {summary.range}
      {#if summary.loading}<span class="hint">wird geladen …</span>
      {:else}
        <span>gesamt {summary.total}</span>
        <span class="buy">Ask (Käufer) {summary.buy}</span>
        <span class="sell">Bid (Verkäufer) {summary.sell}</span>
        <span>Delta {summary.delta}</span>
        <span class="poc">POC {summary.poc}</span>
        <span>VA {summary.va}</span>
      {/if}
    </div>
  {/if}

  <footer class="readout" data-testid="readout">
    {#if error}<span class="err">{error}</span>{/if}
    {#if dataTo}<span class="datato" title="Ende der Daten (UTC)">
        Daten bis {fmtUtc(dataTo)}
      </span>{/if}
    <button class="diag-toggle" aria-expanded={diagOpen} onclick={() => (diagOpen = !diagOpen)}>
      {diagOpen ? '▾' : '▸'} Diagnose
    </button>
    {#if ro && !diagOpen}
      <span class="compact">
        {ro.tf} · Zeile {ro.rLabel}{ro.rAuto ? ' (auto)' : ''} · L{ro.lod}
        {#if ro.hint}<span class="hint">· {ro.hint}</span>{/if}
        {#if ro.notice}<span class="hint">· {ro.notice}</span>{/if}
        {#if ro.error}<span class="err">· {ro.error}</span>{/if}
        {#if pro && pro.mode !== 'off'}
          · Profil {pro.rLabel}{pro.rAuto ? ' (auto)' : ''}
          {#if pro.note}<span class="hint">· {pro.note}</span>{/if}
          {#if pro.error}<span class="err">· {pro.error}</span>
            <button class="dismiss" title="Meldung schließen" onclick={dismissProfileError}>
              ✕
            </button>{/if}
        {:else if pro?.note}<span class="hint">· {pro.note}</span>{/if}
      </span>
    {/if}
    {#if ro && diagOpen}
      <span>tf <b data-k="tf">{ro.tf}</b></span>
      <span>
        Zeile <b data-k="R">{ro.rLabel}</b> ({ro.R} Ticks, {ro.rAuto
          ? `auto${ro.rowClass ? ' ' + ro.rowClass : ''}`
          : 'manuell'})
      </span>
      <span>LOD <b data-k="lod">L{ro.lod}</b> ({ro.mode})</span>
      <span>
        Bars mit Zahlen <b data-k="textBars">{ro.textBars}</b> · Zeilen/Bar {ro.rowsMedian} (max
        {ro.rowsMax})
      </span>
      <span>Zellen sichtbar <b data-k="vc">{ro.visibleCells}</b> / gezeichnet {ro.cellsDrawn}</span>
      <span>Frame <b data-k="frame">{ro.lastFrameMs.toFixed(2)} ms</b></span>
      <span>bs {ro.barSpacing.toFixed(1)} px · rh {ro.rowHeight.toFixed(1)} px</span>
      <span>
        Fenster {ro.windowBars} Bars · Kacheln {ro.fpTiles} ({ro.fpCells} Zellen) · Requests {ro.requests}
      </span>
      {#if ro.hint}<span class="hint">{ro.hint}</span>{/if}
      <!-- W-2: erwartete/vorübergehende Gründe ohne Footprint als normale Zeile, nicht als Banner -->
      {#if ro.notice}<span class="hint" data-k="notice">{ro.notice}</span>{/if}
      {#if ro.error}<span class="err">{ro.error}</span>{/if}
      {#if pro}
        <span>
          Profil <b data-k="pmode">{pro.mode}/{pro.view}</b> · Zeile <b data-k="pR">{pro.rLabel}</b>
          ({pro.R} Ticks, {pro.rAuto ? 'auto' : 'manuell'}) · Tage
          <b data-k="pdays">{pro.daysDrawn}</b>
          gezeichnet · Requests {pro.requests}
        </span>
        {#if pro.note}<span class="hint" data-k="pnote">{pro.note}</span>{/if}
        {#if pro.error}<span class="err" data-k="perror">{pro.error}</span>
          <button class="dismiss" title="Meldung schließen" onclick={dismissProfileError}>
            ✕
          </button>{/if}
      {/if}
    {/if}
    <span class="legend">
      Mengen in Basiswährung (BTC) · Delta = Ask − Bid · Bid×Ask: Bid links, Ask rechts · Δ + Vol:
      Delta links, Volumen (blau) rechts · gelber Rahmen = POC · türkis/orange Rahmen = Δ-POC (+/−)
      · Imbalance: grüner Strich rechts = Ask dominiert (diagonal gegen Bid eine Zeile tiefer),
      roter Strich links = Bid dominiert, breit + Fläche = Stacked (nach rechts bis zur Berührung) ·
      Bar-VA: Balken links der Spalte · Minuten ohne Trades fehlen in den Daten (z. B. Loch
      2026-10-27): der Tages-CVD summiert die vorhandenen Bars, „–" nach einem fehlenden
      Datenabschnitt bzw. wenn die Tagesgrenze nicht auf einer Bar-Grenze liegt · Profil: Bid (rot)
      links, Ask (grün) rechts; Delta grün/rot nach Vorzeichen; gelbe Linie = POC, graue Linien =
      VAH/VAL; Skala {prof.scale === 'common'
        ? 'gemeinsam über die sichtbaren Tage'
        : 'je Profil (längster Balken = größte Zeile des Tages)'}
    </span>
    <span class="hover">{hover}</span>
    <a class="attr" href={CHARTS_URL} rel="noreferrer">{CHARTS_ATTRIBUTION}</a>
  </footer>
</main>

<style>
  :global(html, body) {
    margin: 0;
    height: 100%;
    background: #0f1217;
    color: #c9d1d9;
    font:
      13px/1.4 system-ui,
      sans-serif;
  }
  :global(#app) {
    height: 100%;
  }
  main {
    display: flex;
    flex-direction: column;
    height: 100%;
  }
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: center;
    padding: 6px 10px;
    border-bottom: 1px solid #222934;
  }
  .group {
    display: inline-flex;
  }
  button,
  select {
    background: #171c24;
    color: inherit;
    border: 1px solid #2a313c;
    padding: 3px 8px;
    font: inherit;
  }
  button.active {
    background: #2a3a55;
    border-color: #3d5a88;
  }
  .chart {
    flex: 1;
    min-height: 0;
    position: relative;
  }
  .readout {
    display: flex;
    flex-wrap: wrap;
    gap: 14px;
    padding: 4px 10px;
    border-top: 1px solid #222934;
    font:
      12px/1.5 ui-monospace,
      Menlo,
      monospace;
  }
  .banner {
    position: absolute;
    z-index: 5;
    top: 8px;
    left: 50%;
    transform: translateX(-50%);
    max-width: 80%;
    padding: 6px 12px;
    background: #3b1d1d;
    border: 1px solid #ef5350;
    color: #ffd7d5;
    font-weight: 600;
  }
  .sym {
    font-weight: 600;
  }
  .datato {
    color: #8b949e;
  }
  .sym-select {
    max-width: 9.5em;
  }
  .diag-toggle {
    padding: 0 6px;
    font: inherit;
  }
  .dismiss {
    padding: 0 4px;
    font: inherit;
  }
  .legend {
    color: #8b949e;
  }
  .hover {
    flex-basis: 100%;
    min-height: 1.5em;
    color: #e6edf3;
  }
  .menu {
    position: relative;
    display: inline-block;
  }
  .menu.right .panel {
    left: auto;
    right: 0;
  }
  .menu .panel button {
    white-space: nowrap;
  }
  .menu summary {
    list-style: none;
    cursor: pointer;
    background: #171c24;
    border: 1px solid #2a313c;
    padding: 3px 6px;
  }
  .menu summary::-webkit-details-marker {
    display: none;
  }
  .menu .panel {
    position: absolute;
    z-index: 10;
    top: 100%;
    left: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 280px;
    padding: 8px;
    background: #12161d;
    border: 1px solid #2a313c;
  }
  .summary {
    display: flex;
    flex-wrap: wrap;
    gap: 14px;
    padding: 4px 10px;
    border-top: 1px solid #222934;
    font:
      12px/1.5 ui-monospace,
      Menlo,
      monospace;
  }
  .buy {
    color: #26a69a;
  }
  .sell {
    color: #ef5350;
  }
  .poc {
    color: #f2c94c;
  }
  .hint {
    color: #f2c94c;
  }
  .err {
    color: #ef5350;
  }
  .attr {
    margin-left: auto;
    color: #8b949e;
  }
</style>
