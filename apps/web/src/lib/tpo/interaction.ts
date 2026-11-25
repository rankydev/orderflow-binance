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

/** Zoomfaktor der Spaltenbreite aus deltaY (nach oben = größer, wie die Chart-Seite). */
export function wheelZoomFactor(deltaY: number, ctrlKey: boolean): number {
  return Math.exp(-deltaY * (ctrlKey ? 0.01 : 0.002));
}

/**
 * Ziehen auf der Preisachse: nach oben = Preisbereich kleiner (Zeilen höher), um die Mitte; dy in px.
 * Liefert den neuen Bereich [top, bottom].
 */
export function priceAxisDrag(pTop: number, pBot: number, dy: number): [number, number] {
  const f = Math.exp(dy * 0.004);
  const mid = (pTop + pBot) / 2;
  return [mid + (pTop - mid) * f, mid + (pBot - mid) * f];
}
