// Bedienung der TPO-Ansicht wie die Chart-Seite (lightweight-charts): Mausrad zoomt die Zeitachse (hier:
// Spaltenbreite) um den Zeiger, waagrechtes Scrollen (Touchpad) verschiebt, Pinch (ctrl + Rad) zoomt,
// Ziehen auf der Preisachse skaliert den Preis, Ziehen in der Fläche verschiebt. Reine Rechnungen, getestet.

/** Spaltenbreite (px je Tag): Grenzen. */
export const TPO_COL_MIN = 40;
export const TPO_COL_MAX = 1600;

/**
 * Erlaubte Verschiebung (px; 0 = letzter Tag am rechten Rand, > 0 = in die Vergangenheit): nach rechts
 * freier Raum, bis der letzte Tag am linken Rand steht (wie die Chart-Seite, die über den letzten Bar
 * hinaus scrollt), nach links bis der erste Tag am rechten Rand steht.
 */
export function scrollBounds(nDays: number, colW: number, plotW: number): [number, number] {
  return [-Math.max(0, plotW - colW), Math.max(0, (nDays - 1) * colW)];
}

export function clampScroll(scrollPx: number, nDays: number, colW: number, plotW: number): number {
  const [lo, hi] = scrollBounds(nDays, colW, plotW);
  return Math.min(hi, Math.max(lo, scrollPx));
}

/**
 * Spaltenbreite um den Faktor f ändern, verankert an x (CSS-px): die Zeitposition unter dem Zeiger bleibt
 * unter dem Zeiger. Liefert neue Breite und Verschiebung (begrenzt).
 */
export function zoomColumnsAt(
  colW: number,
  scrollPx: number,
  f: number,
  x: number,
  plotW: number,
  nDays: number,
): { colW: number; scrollPx: number } {
  const w = Math.min(TPO_COL_MAX, Math.max(TPO_COL_MIN, colW * f));
  // Abstand des Ankers vom rechten Rand in „Tagen": (plotW − x + scroll) / colW bleibt gleich
  const days = (plotW - x + scrollPx) / colW;
  return { colW: w, scrollPx: clampScroll(days * w - (plotW - x), nDays, w, plotW) };
}

/** Was ein Radereignis bedeutet: Zoom (senkrecht, Pinch = ctrl) oder Verschieben (waagrecht, Shift). */
export function wheelIntent(e: {
  deltaX: number;
  deltaY: number;
  ctrlKey: boolean;
  shiftKey: boolean;
}): 'zoom' | 'pan' {
  if (e.ctrlKey) return 'zoom';
  if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return 'pan';
  return 'zoom';
}

/**
 * Rad-Deltas in Pixel (W-3): deltaMode 1 = Zeilen (Firefox-Mausrad) → × 16 px, 2 = Seiten → × Höhe der
 * Ansicht; 0 = Pixel bleibt.
 */
export function normalizeWheel(
  e: { deltaX: number; deltaY: number; deltaMode: number },
  pageH: number,
): { deltaX: number; deltaY: number } {
  const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? pageH : 1;
  return { deltaX: e.deltaX * k, deltaY: e.deltaY * k };
}

/**
 * Zoomfaktor der Spaltenbreite aus deltaY in Pixel (nach oben = größer, wie die Chart-Seite); je Ereignis
 * auf [1/2, 2] begrenzt (sehr große Deltas springen sonst ins Extreme).
 */
export function wheelZoomFactor(deltaY: number, ctrlKey: boolean): number {
  const f = Math.exp(-deltaY * (ctrlKey ? 0.01 : 0.002));
  return Math.min(2, Math.max(0.5, f));
}

/** Waagrechte Verschiebung je Radereignis (px), begrenzt auf ± eine Zeichenflächenbreite. */
export function wheelPan(delta: number, plotW: number): number {
  return Math.max(-plotW, Math.min(plotW, -delta));
}

/**
 * Ziehen auf der Preisachse: nach oben = Preisbereich kleiner (Zeilen höher), um die Mitte; dy in px.
 * Liefert den neuen Bereich [top, bottom].
 */
export function priceAxisDrag(
  pTop: number,
  pBot: number,
  dy: number,
  minSpan = 0,
  maxSpan = Infinity,
): [number, number] {
  return scalePriceSpan(pTop, pBot, Math.exp(dy * 0.004), minSpan, maxSpan);
}

/**
 * Preisbereich um die Mitte mit Faktor f skalieren, Spanne auf [minSpan, maxSpan] begrenzt (W-4: sonst
 * schrumpft sie gegen 0 → Division durch 0 in der Preisabbildung und der Zeilengröße). Die Unterkante
 * bleibt ≥ 0 (keine negativen Preise an der Achse); der Bereich wird dann nach oben verschoben.
 */
export function scalePriceSpan(
  pTop: number,
  pBot: number,
  f: number,
  minSpan: number,
  maxSpan: number,
): [number, number] {
  const mid = (pTop + pBot) / 2;
  const span = Math.min(maxSpan, Math.max(minSpan, (pTop - pBot) * f));
  return floorPriceRange(mid + span / 2, mid - span / 2);
}

/** Preise sind ≥ 0: liegt die Unterkante unter 0, den Bereich nach oben schieben (Spanne bleibt). */
export function floorPriceRange(pTop: number, pBot: number): [number, number] {
  return pBot >= 0 ? [pTop, pBot] : [pTop - pBot, 0];
}

/** Grenzen der Preisspanne: ≥ 20 Ticks, ≤ 20 × Datenspanne der sichtbaren Tage (mind. 20 Ticks). */
export function priceSpanLimits(tickUnits: number, dataSpan: number): [number, number] {
  const lo = 20 * tickUnits;
  return [lo, Math.max(lo, 20 * dataSpan)];
}

/**
 * Zwei-Finger-Pinch (W-5): Faktor aus dem waagrechten Abstand der beiden Zeiger vorher/nachher (mind.
 * 10 px, sonst 1) und der Anker in der Mitte.
 */
export function pinchStep(
  a0: { x: number },
  b0: { x: number },
  a1: { x: number },
  b1: { x: number },
): { f: number; x: number } {
  const d0 = Math.abs(a0.x - b0.x);
  const d1 = Math.abs(a1.x - b1.x);
  return { f: d0 >= 10 && d1 >= 10 ? d1 / d0 : 1, x: (a1.x + b1.x) / 2 };
}
