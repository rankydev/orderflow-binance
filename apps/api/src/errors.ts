// HTTP-Fehler mit Status und optionalen Zusatzfeldern im JSON-Körper ({ error, ... }).

export class HttpError extends Error {
  readonly status: number;
  readonly extra: Record<string, unknown>;
  /** Sekunden für Retry-After (nur 503/429). */
  readonly retryAfter: number | null;
  constructor(
    status: number,
    message: string,
    extra: Record<string, unknown> = {},
    retryAfter: number | null = null,
  ) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.extra = extra;
    this.retryAfter = retryAfter;
  }
}

export const badRequest = (m: string) => new HttpError(400, m);
export const notFound = (m: string) => new HttpError(404, m);
export const unprocessable = (m: string, extra: Record<string, unknown> = {}) =>
  new HttpError(422, m, extra);
export const busy = (m: string, retryAfter = 1) => new HttpError(503, m, {}, retryAfter);
