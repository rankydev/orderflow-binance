// Antworten: ETag/304, Cache-Control nach Unveränderlichkeit (TILE-FORMAT.md), gzip nach
// Accept-Encoding (aus dem Cache vorkomprimiert), Diagnose-Header.
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { gzip as gzipCb, constants as zc } from 'node:zlib';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { CachedResponse } from './cache.ts';

const gzipAsync = promisify(gzipCb);

export const IMMUTABLE = 'public, max-age=31536000, immutable';
export const NO_CACHE = 'no-cache';
/** Unter dieser Größe lohnt gzip nicht. */
const GZIP_MIN = 1024;

export function acceptsGzip(req: FastifyRequest): boolean {
  const ae = req.headers['accept-encoding'];
  const v = Array.isArray(ae) ? ae.join(',') : (ae ?? '');
  return /\bgzip\b/i.test(v) && !/\bgzip\s*;\s*q=0(\.0*)?\b/i.test(v);
}

export async function gzip(body: Buffer): Promise<Buffer> {
  return gzipAsync(body, { level: 6, memLevel: 9, strategy: zc.Z_DEFAULT_STRATEGY });
}

/** Erzeugt eine Antwort samt (bei Bedarf) gzip-Fassung; final → für den Cache vollständig. */
export async function makeResponse(
  body: Buffer,
  type: string,
  etag: string,
  final: boolean,
  wantGzip: boolean,
): Promise<CachedResponse> {
  const gz = body.length >= GZIP_MIN && (final || wantGzip) ? await gzip(body) : null;
  return { body, gzip: gz, type, etag, final };
}

export function etagOfBody(body: Buffer | string): string {
  return createHash('sha256').update(body).digest('base64url').slice(0, 27);
}

function matchesEtag(req: FastifyRequest, etag: string): boolean {
  const inm = req.headers['if-none-match'];
  if (!inm) return false;
  const v = Array.isArray(inm) ? inm.join(',') : inm;
  if (v.trim() === '*') return true;
  return v.split(',').some((t) => t.trim().replace(/^W\//, '') === `"${etag}"`);
}

/** Sendet eine Antwort mit ETag/304, Cache-Control und gzip. */
export function send(req: FastifyRequest, reply: FastifyReply, r: CachedResponse): FastifyReply {
  reply.header('ETag', `"${r.etag}"`);
  reply.header('Cache-Control', r.final ? IMMUTABLE : NO_CACHE);
  reply.header('Vary', 'Accept-Encoding, Origin');
  if (matchesEtag(req, r.etag)) {
    req.ctx.bytes = 0;
    return reply.code(304).send();
  }
  reply.type(r.type);
  if (r.gzip && acceptsGzip(req)) {
    reply.header('Content-Encoding', 'gzip');
    req.ctx.bytes = r.gzip.length;
    req.ctx.rawBytes = r.body.length;
    return reply.send(r.gzip);
  }
  req.ctx.bytes = r.body.length;
  req.ctx.rawBytes = r.body.length;
  return reply.send(r.body);
}
