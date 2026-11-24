// Kachel-Anfragen (KONZEPT §5.4): höchstens 4 parallel, Reihenfolge nach Priorität, jede Anfrage mit
// AbortController; verlässt eine Kachel den Bedarf (inkl. Rückhaltezone), wird sie abgebrochen.
// Fehlgeschlagene Anfragen werden mit Backoff und höchstens 3 Versuchen wiederholt; 4xx sind endgültig
// (kein Nachladen in einer Schleife).

export interface Want {
  key: string;
  url: string;
  priority: number;
}

export interface QueueStats {
  started: number;
  completed: number;
  aborted: number;
  failed: number;
  inFlight: number;
  queued: number;
}

export type FetchFn = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

export class RequestQueue {
  private queue: Want[] = [];
  private readonly inFlight = new Map<string, AbortController>();
  private readonly failures = new Map<
    string,
    { attempts: number; retryAt: number; final: boolean }
  >();
  readonly stats: QueueStats = {
    started: 0,
    completed: 0,
    aborted: 0,
    failed: 0,
    inFlight: 0,
    queued: 0,
  };

  private readonly onLoaded: (key: string, buf: ArrayBuffer) => void;
  private readonly onRejected: (key: string, status: number) => void;
  private readonly fetchFn: FetchFn;
  readonly maxParallel: number;
  private readonly now: () => number;

  constructor(
    onLoaded: (key: string, buf: ArrayBuffer) => void,
    onRejected: (key: string, status: number) => void,
    fetchFn: FetchFn = (u, i) => fetch(u, i),
    maxParallel = 4,
    now: () => number = () => performance.now(),
  ) {
    this.onLoaded = onLoaded;
    this.onRejected = onRejected;
    this.fetchFn = fetchFn;
    this.maxParallel = maxParallel;
    this.now = now;
  }

  /**
   * Ersetzt den Bedarf. `wants` darf bereits geladene Schlüssel nicht enthalten (Aufrufer filtert).
   * Laufende Anfragen außerhalb von `retain` (⊇ wants) werden abgebrochen.
   */
  setWanted(wants: Want[], retain: ReadonlySet<string>): void {
    for (const [key, ac] of this.inFlight) {
      if (!retain.has(key)) {
        ac.abort();
        this.inFlight.delete(key);
        this.stats.aborted++;
      }
    }
    const t = this.now();
    this.queue = wants
      .filter((w) => !this.inFlight.has(w.key))
      .filter((w) => {
        const f = this.failures.get(w.key);
        return !f || (!f.final && f.retryAt <= t);
      })
      .sort((a, b) => a.priority - b.priority);
    this.pump();
  }

  isPending(key: string): boolean {
    return this.inFlight.has(key);
  }

  cancelAll(): void {
    this.setWanted([], new Set());
  }

  private pump(): void {
    while (this.inFlight.size < this.maxParallel && this.queue.length > 0) {
      const w = this.queue.shift()!;
      if (this.inFlight.has(w.key)) continue;
      this.start(w);
    }
    this.stats.inFlight = this.inFlight.size;
    this.stats.queued = this.queue.length;
  }

  private start(w: Want): void {
    const ac = new AbortController();
    this.inFlight.set(w.key, ac);
    this.stats.started++;
    const done = () => {
      if (this.inFlight.get(w.key) === ac) this.inFlight.delete(w.key);
      this.pump();
    };
    this.fetchFn(w.url, { signal: ac.signal })
      .then(async (res) => {
        if (ac.signal.aborted) return;
        if (res.ok) {
          const buf = await res.arrayBuffer();
          if (ac.signal.aborted) return;
          this.failures.delete(w.key);
          this.stats.completed++;
          // Erst austragen, dann melden: der Verbraucher darf im Rückruf neuen Bedarf setzen.
          if (this.inFlight.get(w.key) === ac) this.inFlight.delete(w.key);
          this.onLoaded(w.key, buf);
        } else if (res.status >= 400 && res.status < 500) {
          this.stats.failed++;
          this.failures.set(w.key, { attempts: 1, retryAt: Infinity, final: true });
          this.onRejected(w.key, res.status);
        } else {
          this.fail(w.key);
        }
      })
      .catch((e: unknown) => {
        if (ac.signal.aborted || (e instanceof DOMException && e.name === 'AbortError')) return;
        this.fail(w.key);
      })
      .finally(done);
  }

  private fail(key: string): void {
    this.stats.failed++;
    const f = this.failures.get(key) ?? { attempts: 0, retryAt: 0, final: false };
    f.attempts++;
    f.retryAt = this.now() + 1000 * 2 ** f.attempts;
    f.final = f.attempts >= 3;
    this.failures.set(key, f);
  }
}
