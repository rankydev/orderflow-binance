// WebSocket-Verbindung für mehrere aggTrade-Streams (ein kombinierter Stream). Neuaufbau mit
// exponentiellem Backoff; kein Datum für 15 s → Neuaufbau; geplanter Wechsel vor Ablauf der 24 h
// mit Überlappung (neue Verbindung zuerst, alte erst nach der ersten Nachricht der neuen schließen;
// Duplikate verwirft der Feed per aggId). Die Socket-Fabrik ist injizierbar (Tests).

export interface SocketLike {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  close(code?: number, reason?: string): void;
}

export type SocketFactory = (url: string) => SocketLike;

export interface StreamOptions {
  url: string;
  factory: SocketFactory;
  onMessage: (stream: string, data: unknown) => void;
  onState?: (connected: boolean, info: string) => void;
  /** geplanter Wechsel (Standard 23 h). */
  rotateAfterMs?: number;
  /** Stille bis zum Neuaufbau (Standard 15 s). */
  silenceMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

export class StreamClient {
  private readonly o: Required<Omit<StreamOptions, 'onState'>> & Pick<StreamOptions, 'onState'>;
  private sock: SocketLike | null = null;
  private next: SocketLike | null = null;
  private openedAt = 0;
  private lastMsg = 0;
  private attempt = 0;
  private stopped = false;
  private timer: unknown = null;
  reconnects = 0;
  rotations = 0;
  messages = 0;
  connected = false;

  constructor(o: StreamOptions) {
    this.o = {
      rotateAfterMs: 23 * 3600_000,
      silenceMs: 15_000,
      now: Date.now,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (t) => clearTimeout(t as NodeJS.Timeout),
      ...o,
    };
  }

  start(): void {
    this.stopped = false;
    this.connect();
    this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) this.o.clearTimer(this.timer);
    this.sock?.close(1000, 'stop');
    this.next?.close(1000, 'stop');
    this.sock = null;
    this.next = null;
    this.connected = false;
  }

  lastMessageAgeMs(): number {
    return this.lastMsg ? this.o.now() - this.lastMsg : Infinity;
  }

  private tick(): void {
    if (this.stopped) return;
    const now = this.o.now();
    if (this.sock && this.connected && this.lastMsg && now - this.lastMsg > this.o.silenceMs) {
      this.o.onState?.(false, `keine Nachricht seit ${now - this.lastMsg} ms: Neuaufbau`);
      this.reconnect();
    } else if (
      this.sock &&
      this.connected &&
      !this.next &&
      now - this.openedAt > this.o.rotateAfterMs
    ) {
      this.rotate();
    }
    this.timer = this.o.setTimer(() => this.tick(), 1000);
  }

  private wire(s: SocketLike, isRotation: boolean): void {
    s.onopen = () => {
      if (s !== this.sock && s !== this.next) return;
      this.attempt = 0;
      if (!isRotation) {
        this.connected = true;
        this.openedAt = this.o.now();
        this.o.onState?.(true, 'verbunden');
      }
    };
    s.onmessage = (ev) => {
      if (s === this.next) {
        // erste Nachricht der neuen Verbindung: umschalten, alte schließen
        const old = this.sock;
        this.sock = s;
        this.next = null;
        this.openedAt = this.o.now();
        this.rotations++;
        old?.close(1000, 'rotation');
        this.o.onState?.(true, 'geplanter Wechsel abgeschlossen');
      }
      if (s !== this.sock) return;
      this.lastMsg = this.o.now();
      this.messages++;
      let msg: { stream?: string; data?: unknown };
      try {
        msg = JSON.parse(String(ev.data)) as { stream?: string; data?: unknown };
      } catch {
        return;
      }
      if (msg.stream && msg.data) this.o.onMessage(msg.stream, msg.data);
    };
    s.onclose = (ev) => {
      if (s === this.next) {
        this.next = null;
        return;
      }
      if (s !== this.sock) return;
      this.connected = false;
      this.sock = null;
      this.o.onState?.(false, `geschlossen (${ev.code ?? '?'} ${ev.reason ?? ''})`);
      if (!this.stopped) this.scheduleReconnect();
    };
    s.onerror = () => {
      /* close folgt */
    };
  }

  private connect(): void {
    const s = this.o.factory(this.o.url);
    this.sock = s;
    this.lastMsg = 0;
    this.wire(s, false);
  }

  private scheduleReconnect(): void {
    const delay = Math.min(60_000, 1000 * 2 ** this.attempt);
    this.attempt++;
    this.reconnects++;
    this.o.setTimer(() => {
      if (!this.stopped && !this.sock) this.connect();
    }, delay);
  }

  private reconnect(): void {
    const s = this.sock;
    this.sock = null;
    this.connected = false;
    s?.close(4000, 'silence');
    this.scheduleReconnect();
  }

  /** Neue Verbindung parallel öffnen; umgeschaltet wird bei ihrer ersten Nachricht. */
  rotate(): void {
    if (this.next || !this.sock) return;
    this.next = this.o.factory(this.o.url);
    this.wire(this.next, true);
  }
}
