// HTTP-Fehler mit Status und optionalen Zusatzfeldern im JSON-Körper ({ error, ... }).

export class HttpError extends Error {
  readonly status: number;
  readonly extra: Record<string, unknown>;
  /** Sekunden für Retry-After (nur 503/429). */
  readonly retryAfter: number | null;
  /** Ursache eines 503 (intern, nicht im Antwortkörper): Verbindungsverlust, Sperre, Zeitlimit … */
  readonly kind: 'connection' | 'lock' | 'timeout' | 'overload' | 'inconsistent' | null;
  constructor(
    status: number,
    message: string,
    extra: Record<string, unknown> = {},
    retryAfter: number | null = null,
    kind: HttpError['kind'] = null,
  ) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.extra = extra;
    this.retryAfter = retryAfter;
    this.kind = kind;
  }
}

export const badRequest = (m: string) => new HttpError(400, m);
export const notFound = (m: string) => new HttpError(404, m);
export const unprocessable = (m: string, extra: Record<string, unknown> = {}) =>
  new HttpError(422, m, extra);
export const busy = (m: string, retryAfter = 1, kind: HttpError['kind'] = 'overload') =>
  new HttpError(503, m, {}, retryAfter, kind);
