// Begrenzung gleichzeitiger Datenbankarbeit: höchstens `max` Anfragen gleichzeitig, höchstens
// `maxQueue` wartend, Wartezeit begrenzt; ein abgebrochener Client verlässt die Warteschlange sofort.
// So kann ein Ansturm Postgres nicht aushungern (KONZEPT §2.4: max_connections = 30 auf dem VPS).
import { busy, HttpError } from './errors.ts';

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (e: unknown) => void;
}

export class Limiter {
  private active = 0;
  private readonly queue: Waiter[] = [];
  readonly max: number;
  readonly maxQueue: number;
  readonly timeoutMs: number;
  rejected = 0;

  constructor(max: number, maxQueue: number, timeoutMs: number) {
    this.max = max;
    this.maxQueue = maxQueue;
    this.timeoutMs = timeoutMs;
  }

  get running(): number {
    return this.active;
  }
  get waiting(): number {
    return this.queue.length;
  }

  private releaser(): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const next = this.queue.shift();
      if (next) next.resolve(this.releaser());
      else this.active--;
    };
  }

  /** Wartet auf einen Platz; wirft 503 (voll/zu lange gewartet) oder den Abbruchgrund. */
  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(new HttpError(499, 'Client hat abgebrochen'));
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve(this.releaser());
    }
    if (this.queue.length >= this.maxQueue) {
      this.rejected++;
      return Promise.reject(busy('Server ausgelastet, bitte später erneut', 1));
    }
    return new Promise((resolve, reject) => {
      const w: Waiter = {
        resolve: (rel) => {
          cleanup();
          if (signal.aborted) rel();
          else resolve(rel);
        },
        reject,
      };
      const remove = () => {
        const i = this.queue.indexOf(w);
        if (i >= 0) this.queue.splice(i, 1);
      };
      const onAbort = () => {
        remove();
        cleanup();
        reject(new HttpError(499, 'Client hat abgebrochen'));
      };
      const timer = setTimeout(() => {
        remove();
        cleanup();
        this.rejected++;
        reject(busy('Wartezeit überschritten, bitte später erneut', 1));
      }, this.timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.queue.push(w);
    });
  }
}
