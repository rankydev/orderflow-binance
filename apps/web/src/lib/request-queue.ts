// Kachel-Anfragen (KONZEPT §5.4): höchstens 4 parallel, Reihenfolge nach Priorität, jede Anfrage mit
// AbortController; verlässt eine Kachel den Bedarf (inkl. Rückhaltezone), wird sie abgebrochen.
// Fehlerklassen (Review W2):
//  - endgültig: 400, 404, 410, 422 und andere 4xx außer 408/425/429 → onRejected, nie erneut;
//  - vorübergehend: 408, 425, 429, 5xx, Netzwerkfehler → Wiederholung per Timer nach Backoff
//    (Retry-After wird beachtet), solange der Schlüssel noch gewünscht ist; nach 3 Fehlschlägen
//    30 s Pause, danach wieder (keine dauerhafte Sperre nach kurzem Ausfall, keine Schleife);
//  - Verarbeitungsfehler (Decoder/Validierung in onLoaded wirft): getrennt gezählt, sichtbar
//    (console.error + stats.decodeErrors), endgültig für diesen Schlüssel.

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
  /** Fehler beim Verarbeiten einer erfolgreichen Antwort (Decoder, Header-Prüfung). */
  decodeErrors: number;
  inFlight: number;
  queued: number;
}

export type FetchFn = (url: string, init: { signal: AbortSignal }) => Promise<Response>;
export type Scheduler = (fn: () => void, ms: number) => () => void;

const RETRYABLE = new Set([408, 425, 429]);
export const PARK_MS = 30_000;
export const MAX_RETRY_AFTER_MS = 5 * 60_000;
export const MAX_ATTEMPTS = 3;

export function isTransient(status: number): boolean {
  return status >= 500 || RETRYABLE.has(status);
}

interface Failure {
  attempts: number;
  retryAt: number;
  final: boolean;
}

export class RequestQueue {
  private queue: Want[] = [];
  private wanted: Want[] = [];
  private readonly inFlight = new Map<string, AbortController>();
  private readonly failures = new Map<string, Failure>();
  private cancelTimer: (() => void) | null = null;
  readonly stats: QueueStats = {
    started: 0,
    completed: 0,
    aborted: 0,
    failed: 0,
    decodeErrors: 0,
    inFlight: 0,
    queued: 0,
  };
  /** Letzter Verarbeitungsfehler (für die Anzeige). */
  lastError = '';

  private readonly onLoaded: (key: string, buf: ArrayBuffer) => void;
  private readonly onRejected: (key: string, status: number, error?: unknown) => void;
  private readonly fetchFn: FetchFn;
  readonly maxParallel: number;
  private readonly now: () => number;
  private readonly schedule: Scheduler;

  constructor(
    onLoaded: (key: string, buf: ArrayBuffer) => void,
    onRejected: (key: string, status: number, error?: unknown) => void,
    fetchFn: FetchFn = (u, i) => fetch(u, i),
    maxParallel = 4,
    now: () => number = () => performance.now(),
    schedule: Scheduler = (fn, ms) => {
      const id = setTimeout(fn, ms);
      return () => clearTimeout(id);
    },
  ) {
    this.onLoaded = onLoaded;
    this.onRejected = onRejected;
    this.fetchFn = fetchFn;
    this.maxParallel = maxParallel;
    this.now = now;
    this.schedule = schedule;
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
    this.wanted = [...wants].sort((a, b) => a.priority - b.priority);
    this.requeue();
  }

  isPending(key: string): boolean {
    return this.inFlight.has(key);
  }

  /** true, wenn der Schlüssel endgültig gescheitert ist (wird nicht mehr angefragt). */
  isFinal(key: string): boolean {
    return this.failures.get(key)?.final ?? false;
  }

  cancelAll(): void {
    this.setWanted([], new Set());
  }

  /** Fehlerzustand eines Schlüssels vergessen (z. B. abgelaufene Ablehnung, W-3). */
  forgetFailure(key: string): void {
    this.failures.delete(key);
  }

  /** Alle endgültigen/pausierten Fehler vergessen (z. B. per Knopf „neu laden"). */
  clearFailures(): void {
    this.failures.clear();
    this.requeue();
  }

  private requeue(): void {
    const t = this.now();
    this.queue = this.wanted.filter((w) => {
      if (this.inFlight.has(w.key)) return false;
      const f = this.failures.get(w.key);
      return !f || (!f.final && f.retryAt <= t);
    });
    this.pump();
    this.armTimer();
  }

  /** Timer auf den frühesten Wiederholungszeitpunkt eines noch gewünschten Schlüssels. */
  private armTimer(): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
    let next = Infinity;
    for (const w of this.wanted) {
      const f = this.failures.get(w.key);
      if (f && !f.final && !this.inFlight.has(w.key)) next = Math.min(next, f.retryAt);
    }
    if (next === Infinity) return;
    this.cancelTimer = this.schedule(
      () => {
        this.cancelTimer = null;
        this.requeue();
      },
      Math.max(0, next - this.now()),
    );
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
    const release = () => {
      if (this.inFlight.get(w.key) === ac) this.inFlight.delete(w.key);
    };
    this.fetchFn(w.url, { signal: ac.signal })
      .then(async (res) => {
        if (ac.signal.aborted) return;
        if (res.ok) {
          const buf = await res.arrayBuffer();
          if (ac.signal.aborted) return;
          this.failures.delete(w.key);
          this.stats.completed++;
          if (this.lastError.startsWith(`${w.key}:`)) this.lastError = '';
          // Erst austragen, dann melden: der Verbraucher darf im Rückruf neuen Bedarf setzen.
          // Aus dem Bedarf nehmen: geladen ist geladen, bis der Verbraucher neu fragt (keine Schleife).
          release();
          this.wanted = this.wanted.filter((x) => x.key !== w.key);
          try {
            this.onLoaded(w.key, buf);
          } catch (e) {
            this.stats.decodeErrors++;
            this.lastError = `${w.key}: ${e instanceof Error ? e.message : String(e)}`;
            console.error('Kachel unbrauchbar', this.lastError);
            this.failures.set(w.key, { attempts: 1, retryAt: Infinity, final: true });
            this.onRejected(w.key, 0, e);
          }
        } else if (!isTransient(res.status)) {
          this.stats.failed++;
          this.failures.set(w.key, { attempts: 1, retryAt: Infinity, final: true });
          this.onRejected(w.key, res.status);
        } else {
          // sichtbar machen (A): wiederholte Serverfehler dürfen nicht still bleiben
          this.lastError = `${w.key}: HTTP ${res.status} – neuer Versuch folgt`;
          this.fail(w.key, retryAfterMs(res.headers.get('Retry-After')));
        }
      })
      .catch((e: unknown) => {
        if (ac.signal.aborted || (e instanceof DOMException && e.name === 'AbortError')) return;
        this.fail(w.key, null);
      })
      .finally(() => {
        release();
        this.requeue();
      });
  }

  private fail(key: string, retryAfter: number | null): void {
    this.stats.failed++;
    const f = this.failures.get(key) ?? { attempts: 0, retryAt: 0, final: false };
    f.attempts++;
    const backoff = f.attempts >= MAX_ATTEMPTS ? PARK_MS : 1000 * 2 ** f.attempts;
    if (f.attempts >= MAX_ATTEMPTS) f.attempts = 0; // nach der Pause wieder von vorn
    // N5: Retry-After begrenzen (setTimeout > 2^31 ms feuert sofort → enge Schleife)
    f.retryAt = this.now() + Math.max(backoff, Math.min(retryAfter ?? 0, MAX_RETRY_AFTER_MS));
    this.failures.set(key, f);
  }
}

/** Retry-After in Sekunden oder als HTTP-Datum → ms (null, wenn nicht vorhanden/ungültig). */
export function retryAfterMs(h: string | null, nowMs = Date.now()): number | null {
  if (!h) return null;
  if (/^\d+$/.test(h.trim())) return Number(h.trim()) * 1000;
  const t = Date.parse(h);
  return Number.isNaN(t) ? null : Math.max(0, t - nowMs);
}
