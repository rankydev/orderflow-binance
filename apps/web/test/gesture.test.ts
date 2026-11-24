// Gestenregeln (K3, N1, W7) mit künstlicher Uhr.
import { describe, expect, it } from 'vitest';
import { GESTURE_END_MS, GestureTracker, WATCHDOG_MS, type Clock } from '../src/lib/gesture.ts';

function fakeClock() {
  let now = 0;
  const timers: { at: number; fn: () => void; live: boolean }[] = [];
  const clock: Clock = {
    now: () => now,
    set: (fn, ms) => {
      const t = { at: now + ms, fn, live: true };
      timers.push(t);
      return () => (t.live = false);
    },
  };
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = timers.filter((t) => t.live && t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      now = due.at;
      due.live = false;
      due.fn();
    }
    now = end;
  };
  return { clock, advance };
}

function setup() {
  const { clock, advance } = fakeClock();
  let ends = 0;
  let resizes = 0;
  const g = new GestureTracker(
    {
      onEnd: () => ends++,
      onResize: () => resizes++,
    },
    clock,
  );
  return { g, advance, ends: () => ends, resizes: () => resizes };
}

describe('GestureTracker', () => {
  it('Ende 150 ms nach dem Loslassen, genau einmal', () => {
    const t = setup();
    t.g.pointerDown();
    t.g.rangeChange();
    t.advance(500);
    expect(t.ends()).toBe(0);
    t.g.pointerUp();
    t.advance(GESTURE_END_MS - 1);
    expect(t.ends()).toBe(0);
    t.advance(1);
    expect(t.ends()).toBe(1);
    t.advance(10_000);
    expect(t.ends()).toBe(1);
  });

  it('N1: Preisachsen-Ziehen ohne Zeitänderung (nur pointermove) endet nicht nach 1,1 s; pointerup → ein Ende', () => {
    const t = setup();
    t.g.pointerDown();
    for (let i = 0; i < 40; i++) {
      t.g.pointerMove(1); // Taste gedrückt, kein rangeChange
      t.advance(100);
    }
    expect(t.g.active).toBe(true);
    expect(t.ends()).toBe(0);
    t.g.pointerUp();
    t.advance(1000);
    expect(t.ends()).toBe(1);
  });

  it('N1: auch ruhiges Halten unter 3 s beendet die Geste nicht', () => {
    const t = setup();
    t.g.pointerDown();
    t.advance(2500);
    expect(t.ends()).toBe(0);
    t.g.pointerUp();
    t.advance(GESTURE_END_MS);
    expect(t.ends()).toBe(1);
  });

  it('K3: verlorenes pointerup → spätestens nach WATCHDOG_MS ohne Aktivität beendet', () => {
    const t = setup();
    t.g.pointerDown();
    t.advance(WATCHDOG_MS + GESTURE_END_MS + 1);
    expect(t.ends()).toBe(1);
    expect(t.g.watchdogReleases).toBe(1);
  });

  it('N1: nach Watchdog-Freigabe startet eine Bewegung mit gedrückter Taste die Geste neu; pointerup beendet sie wieder', () => {
    const t = setup();
    t.g.pointerDown();
    t.advance(WATCHDOG_MS + GESTURE_END_MS + 1);
    expect(t.ends()).toBe(1);
    t.g.pointerMove(1);
    expect(t.g.active).toBe(true);
    t.advance(1000);
    expect(t.ends()).toBe(1); // gehalten → kein Ende
    t.g.pointerUp();
    t.advance(GESTURE_END_MS);
    expect(t.ends()).toBe(2);
  });

  it('pointerup ohne Geste löst nichts aus; Zeigerbewegung ohne Taste beginnt keine Geste', () => {
    const t = setup();
    t.g.pointerMove(0);
    t.g.pointerUp();
    t.advance(1000);
    expect(t.ends()).toBe(0);
    expect(t.g.active).toBe(false);
  });

  it('Rad: jede Rad-Bewegung verlängert, Ende 150 ms nach der letzten', () => {
    const t = setup();
    for (let i = 0; i < 5; i++) {
      t.g.wheel();
      t.advance(100);
    }
    expect(t.ends()).toBe(0);
    t.advance(GESTURE_END_MS);
    expect(t.ends()).toBe(1);
  });

  it('W7: Größenänderung außerhalb einer Geste → entprellt eine Bewertung; während einer Geste keine', () => {
    const t = setup();
    t.g.resize();
    t.g.resize();
    t.advance(GESTURE_END_MS);
    expect(t.resizes()).toBe(1);
    t.g.pointerDown();
    t.g.resize();
    t.advance(GESTURE_END_MS);
    expect(t.resizes()).toBe(1);
  });
});
