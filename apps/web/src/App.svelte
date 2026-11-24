<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { APP_TITLE, CHARTS_ATTRIBUTION, CHARTS_URL } from './app-info.ts';
  import { ChartController, type Readout } from './lib/controller.ts';
  import type { ColorMode, ColorScope, FootprintType } from './lib/types.ts';

  // Nur UI-Einstellungen sind reaktiv (KONZEPT §7.3); Chartdaten liegen im Controller.
  const params = new URLSearchParams(location.search);
  const TIMEFRAMES = ['1m', '5m', '15m', '1h'];
  let sym = $state(params.get('sym') ?? 'BTCUSDT');
  let tf = $state(TIMEFRAMES.includes(params.get('tf') ?? '') ? params.get('tf')! : '1m');
  let type = $state<FootprintType>(params.get('type') === 'bidask' ? 'bidask' : 'delta');
  let rMode = $state<string>('auto');
  let colorMode = $state<ColorMode>('gradient');
  let colorScope = $state<ColorScope>('visible');
  let symbols = $state.raw<string[]>([]);
  let rOptions = $state.raw<number[]>([]);
  let ro = $state.raw<Readout | null>(null);
  let error = $state('');

  let el: HTMLDivElement;
  let ctl: ChartController | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  onMount(() => {
    ctl = new ChartController(el);
    if (import.meta.env.DEV || params.has('debug')) {
      (window as unknown as { __of: ChartController }).__of = ctl;
    }
    ctl.setType(type);
    ctl
      .init(sym, tf)
      .then(() => {
        symbols = ctl!.symbols.map((s) => s.name);
        sym = ctl!.readout().sym;
        rOptions = ctl!.availableR(tf);
      })
      .catch((e: unknown) => (error = e instanceof Error ? e.message : String(e)));
    // Anzeige höchstens 4×/s aktualisieren (keine Kopplung an Frames).
    timer = setInterval(() => {
      if (ctl) ro = ctl.readout();
    }, 250);
  });

  onDestroy(() => {
    if (timer) clearInterval(timer);
    ctl?.destroy();
  });

  function syncUrl(): void {
    const q = `?sym=${encodeURIComponent(sym)}&tf=${tf}&type=${type}${params.has('debug') ? '&debug' : ''}`;
    history.replaceState(null, '', q);
  }

  function chooseTf(v: string): void {
    tf = v;
    rMode = 'auto';
    ctl?.setTimeframe(v);
    rOptions = ctl?.availableR(v) ?? [];
    syncUrl();
  }
  function chooseSym(v: string): void {
    sym = v;
    ctl?.setSymbol(v);
    syncUrl();
  }
  function chooseType(v: FootprintType): void {
    type = v;
    ctl?.setType(v);
    syncUrl();
  }
  function chooseR(v: string): void {
    rMode = v;
    ctl?.setRowMode(v === 'auto' ? 'auto' : Number(v));
  }
</script>

<main>
  <header class="toolbar">
    <strong>{APP_TITLE}</strong>
    <select aria-label="Symbol" value={sym} onchange={(e) => chooseSym(e.currentTarget.value)}>
      {#each symbols as s (s)}<option value={s}>{s}</option>{/each}
    </select>
    <div class="group" role="group" aria-label="Zeitrahmen">
      {#each TIMEFRAMES as t (t)}
        <button class:active={tf === t} onclick={() => chooseTf(t)}>{t}</button>
      {/each}
    </div>
    <div class="group" role="group" aria-label="Footprint-Typ">
      <button class:active={type === 'delta'} onclick={() => chooseType('delta')}>Delta</button>
      <button class:active={type === 'bidask'} onclick={() => chooseType('bidask')}>Bid×Ask</button>
    </div>
    <label>
      R
      <select
        aria-label="Zeilengröße"
        value={rMode}
        onchange={(e) => chooseR(e.currentTarget.value)}
      >
        <option value="auto">auto{ro && ro.rAuto ? ` (${ro.R})` : ''}</option>
        {#each rOptions as r (r)}<option value={String(r)}>{r} Ticks</option>{/each}
      </select>
    </label>
    <label>
      Farbe
      <select
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
  </header>

  <div class="chart" bind:this={el}></div>

  <footer class="readout" data-testid="readout">
    {#if error}<span class="err">{error}</span>{/if}
    {#if ro}
      <span>tf <b data-k="tf">{ro.tf}</b></span>
      <span>R <b data-k="R">{ro.R}</b>{ro.rAuto ? ' auto' : ''}</span>
      <span>LOD <b data-k="lod">L{ro.lod}</b> ({ro.mode})</span>
      <span>Zellen sichtbar <b data-k="vc">{ro.visibleCells}</b> / gezeichnet {ro.cellsDrawn}</span>
      <span>Frame <b data-k="frame">{ro.lastFrameMs.toFixed(2)} ms</b></span>
      <span>bs {ro.barSpacing.toFixed(1)} px · rh {ro.rowHeight.toFixed(1)} px</span>
      <span>
        Fenster {ro.windowBars} Bars · Kacheln {ro.fpTiles} ({ro.fpCells} Zellen) · Requests {ro.requests}
      </span>
      {#if ro.hint}<span class="hint">{ro.hint}</span>{/if}
    {/if}
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
