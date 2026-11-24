// Gestenerkennung (KONZEPT §7.2: Zeilengröße/Modus ändern sich nur am Gestenende, Debounce 150 ms).
// Eigenes Modul mit eingespritzter Uhr, damit die Regeln ohne Browser testbar sind (Review C).
//
// Regeln:
//  - Eine Geste beginnt mit pointerdown, wheel oder einer Zeigerbewegung mit gedrückter Taste.
//  - Aktivität = Bereichsänderung (Zeit), Rad, Zeigerbewegung mit gedrückter Taste (auch reine
//    Preisachsen-Ziehgesten, die den Zeitbereich nicht ändern – Review N1).
//  - Ende = 150 ms ohne Aktivität, nachdem keine Taste mehr gedrückt ist. pointerup (und Ersatz-
//    ereignisse: blur, contextmenu, lostpointercapture, verborgene Seite) beenden das Halten immer,
//    auch wenn es schon beendet war (idempotent).
//  - Sicherung gegen ein verlorenes pointerup (K3): gedrückt, aber WATCHDOG_MS ohne jede Aktivität →
//    Halten beenden. Bewegt sich der Zeiger danach mit gedrückter Taste, beginnt die Geste neu.
//  - Größenänderung des Charts außerhalb einer Geste: nach 150 ms onResize (W7).

export interface Clock {
  now(): number;
  /** setTimeout-Ersatz; liefert eine Abbruchfunktion. */
  set(fn: () => void, ms: number): () => void;
}

export const realClock: Clock = {
  now: () => performance.now(),
  set: (fn, ms) => {
    const id = setTimeout(fn, ms);
    return () => clearTimeout(id);
  },
};

export const GESTURE_END_MS = 150;
export const WATCHDOG_MS = 3000;

export class GestureTracker {
  active = false;
  held = false;
  /** Anzahl beendeter Gesten und Watchdog-Freigaben (Messung/Tests). */
  ends = 0;
  watchdogReleases = 0;
  private lastActivity = 0;
  private cancelEnd: (() => void) | null = null;
  private cancelWatchdog: (() => void) | null = null;
  private cancelResize: (() => void) | null = null;
  private readonly clock: Clock;
  private readonly onBegin: () => void;
  private readonly onEnd: () => void;
  private readonly onResize: () => void;

  constructor(
    cb: { onBegin?: () => void; onEnd: () => void; onResize?: () => void },
    clock: Clock = realClock,
  ) {
    this.onBegin = cb.onBegin ?? (() => {});
    this.onEnd = cb.onEnd;
    this.onResize = cb.onResize ?? (() => {});
    this.clock = clock;
  }

  pointerDown(): void {
    this.held = true;
    this.activity();
    this.begin();
    this.armWatchdog();
  }

  /** Zeigerbewegung; `buttons` wie PointerEvent.buttons. */
  pointerMove(buttons: number): void {
    if (buttons === 0) return;
    this.activity();
    if (!this.held) {
      // Taste ist (wieder) gedrückt, obwohl das Halten beendet wurde (Watchdog): neu beginnen
      this.held = true;
      this.begin();
      this.armWatchdog();
    } else if (this.cancelEnd) {
      this.cancelEnd();
      this.cancelEnd = null;
    }
  }

  /** pointerup und Ersatzereignisse: immer Ende vormerken (idempotent). */
  pointerUp(): void {
    const wasActive = this.active || this.held;
    this.held = false;
    this.cancelWatchdog?.();
    this.cancelWatchdog = null;
    if (wasActive) this.armEnd();
  }

  wheel(): void {
    this.activity();
    this.begin();
    this.armEnd();
  }

  /** Sichtbarer Zeitbereich hat sich geändert. */
  rangeChange(): void {
    this.activity();
    if (this.active) this.armEnd();
  }

  resize(): void {
    this.cancelResize?.();
    this.cancelResize = this.clock.set(() => {
      this.cancelResize = null;
      if (!this.active) this.onResize();
    }, GESTURE_END_MS);
  }

  dispose(): void {
    this.cancelEnd?.();
    this.cancelWatchdog?.();
    this.cancelResize?.();
  }

  private activity(): void {
    this.lastActivity = this.clock.now();
  }

  private begin(): void {
    if (!this.active) {
      this.active = true;
      this.onBegin();
    }
    this.cancelEnd?.();
    this.cancelEnd = null;
  }

  private armEnd(): void {
    this.cancelEnd?.();
    this.cancelEnd = null;
    if (this.held) return;
    this.cancelEnd = this.clock.set(() => {
      this.cancelEnd = null;
      this.active = false;
      this.ends++;
      this.onEnd();
    }, GESTURE_END_MS);
  }

  private armWatchdog(): void {
    this.cancelWatchdog?.();
    this.cancelWatchdog = this.clock.set(() => {
      this.cancelWatchdog = null;
      if (!this.held) return;
      if (this.clock.now() - this.lastActivity >= WATCHDOG_MS) {
        this.watchdogReleases++;
        this.held = false;
        this.armEnd();
      } else this.armWatchdog();
    }, WATCHDOG_MS);
  }
}
