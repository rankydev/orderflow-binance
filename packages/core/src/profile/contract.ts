// Antwortform der Volume-Profile-Endpunkte (docs/PROFILE-API.md). Rein; gemeinsam für API, Web und
// Tests. Prüft eine dekodierte JSON-Antwort auf alle Invarianten, die der Client voraussetzen darf.

export const PROFILE_FORMAT = 1;

/** Ein Profil über einen Zeitraum: dichte Zeilen ab rowLo (innere Zeilen ohne Trades = 0). */
export interface ProfileBody {
  /** Unterste Zeile (Zeilenindex floor(px / w), w = R · tickRefUnits); null bei leerem Profil. */
  rowLo: number | null;
  /** Lots je Zeile, Aggressor Käufer bzw. Verkäufer; Länge = Anzahl Zeilen. */
  buy: number[];
  sell: number[];
  /** Absolute Zeilenindizes; null ohne Volumen. */
  poc: number | null;
  vah: number | null;
  val: number | null;
  deltaPoc: number | null;
  /** Summen über alle Zeilen (Lots). */
  buyQ: number;
  sellQ: number;
  /** Σ px·lots in price_unit·qty_unit als Dezimalstring (kann 2^53 überschreiten; nie als Number lesen). */
  notional: string;
  /** Niedrigster/höchster gehandelter Preis in price_unit; null bei leerem Profil. */
  low: number | null;
  high: number | null;
}

export interface ProfileSource {
  table: string;
  from: number;
  to: number;
}

interface ProfileEnvelope {
  format: number;
  sym: string;
  R: number;
  priceDecimals: number;
  qtyDecimals: number;
  tickRefUnits: number;
  from: number;
  to: number;
  va: number;
  dataVersion: string;
  final: boolean;
  /** Gelesene Quelltabellen je Teilbereich (Transparenz der Quellenwahl). */
  sources: ProfileSource[];
  /** Vor der Ausführung geschätzte Quellzeilen (Guard ≤ 1,5 Mio.). */
  sourceRowsEstimate: number;
}

export interface RangeProfileResponse extends ProfileEnvelope {
  kind: 'profile';
  profile: ProfileBody;
}

export interface DailyProfile extends ProfileBody {
  /** UTC-Datum des Tages d (YYYY-MM-DD); der Tag überdeckt [d·24h + offsetH, (d+1)·24h + offsetH). */
  day: string;
  from: number;
  to: number;
  final: boolean;
}

export interface DailyProfilesResponse extends ProfileEnvelope {
  kind: 'profiles/daily';
  offsetH: number;
  /** Nur Tage mit Trades, aufsteigend. */
  days: DailyProfile[];
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

/** Prüft ein Profil (Invarianten: Längen, Ganzzahligkeit, Summen, Marken im Bereich). */
export function checkProfileBody(p: ProfileBody, where = 'profile'): string[] {
  const out: string[] = [];
  const bad = (m: string) => out.push(`${where}: ${m}`);
  if (!Array.isArray(p.buy) || !Array.isArray(p.sell) || p.buy.length !== p.sell.length) {
    bad('buy/sell fehlen oder ungleich lang');
    return out;
  }
  const n = p.buy.length;
  let sb = 0;
  let ss = 0;
  for (let i = 0; i < n; i++) {
    const b = p.buy[i];
    const s = p.sell[i];
    if (!isInt(b) || !isInt(s) || b < 0 || s < 0) {
      bad(`Zeile ${i}: Mengen ungültig`);
      return out;
    }
    sb += b;
    ss += s;
  }
  if (sb !== p.buyQ || ss !== p.sellQ) bad('Zeilensummen ≠ buyQ/sellQ');
  if (typeof p.notional !== 'string' || !/^\d+$/.test(p.notional))
    bad('notional kein Dezimalstring');
  if (n === 0) {
    if (p.rowLo !== null || p.poc !== null || p.low !== null || p.high !== null)
      bad('leeres Profil mit Werten');
    return out;
  }
  if (!isInt(p.rowLo)) {
    bad('rowLo fehlt');
    return out;
  }
  const hiRow = p.rowLo + n - 1;
  for (const k of ['poc', 'vah', 'val', 'deltaPoc'] as const) {
    const v = p[k];
    if (v !== null && (!isInt(v) || v < p.rowLo || v > hiRow)) bad(`${k} außerhalb der Zeilen`);
  }
  if (sb + ss > 0 && (p.poc === null || p.vah === null || p.val === null)) bad('POC/VA fehlen');
  if (p.val !== null && p.vah !== null && p.poc !== null && !(p.val <= p.poc && p.poc <= p.vah))
    bad('POC nicht in der Value Area');
  if (!isInt(p.low) || !isInt(p.high) || p.low > p.high) bad('low/high ungültig');
  if (n > 0 && (p.buy[0]! + p.sell[0]! === 0 || p.buy[n - 1]! + p.sell[n - 1]! === 0))
    bad('Randzeilen ohne Volumen');
  return out;
}

function checkEnvelope(x: ProfileEnvelope): string[] {
  const out: string[] = [];
  if (x.format !== PROFILE_FORMAT) out.push(`format ${String(x.format)} ≠ ${PROFILE_FORMAT}`);
  for (const k of [
    'R',
    'priceDecimals',
    'qtyDecimals',
    'tickRefUnits',
    'from',
    'to',
    'va',
  ] as const)
    if (!isInt(x[k])) out.push(`${k} ungültig`);
  if (typeof x.dataVersion !== 'string' || typeof x.final !== 'boolean')
    out.push('dataVersion/final fehlen');
  if (!Array.isArray(x.sources)) out.push('sources fehlt');
  return out;
}

/** Prüft eine /api/v1/profile-Antwort; leer = gültig. */
export function checkRangeProfile(x: RangeProfileResponse): string[] {
  const out = checkEnvelope(x);
  if (x.kind !== 'profile') out.push(`kind ${String(x.kind)}`);
  if (typeof x.profile !== 'object' || x.profile === null) return [...out, 'profile fehlt'];
  return [...out, ...checkProfileBody(x.profile)];
}

/** Prüft eine /api/v1/profiles/daily-Antwort; leer = gültig. */
export function checkDailyProfiles(x: DailyProfilesResponse): string[] {
  const out = checkEnvelope(x);
  if (x.kind !== 'profiles/daily') out.push(`kind ${String(x.kind)}`);
  if (!Array.isArray(x.days)) return [...out, 'days fehlt'];
  let prev = -Infinity;
  for (const d of x.days) {
    if (!isInt(d.from) || !isInt(d.to) || d.to - d.from !== 86_400_000 || d.from <= prev)
      out.push(`Tag ${String(d.day)}: Zeitraum ungültig`);
    prev = d.from;
    out.push(...checkProfileBody(d, `Tag ${String(d.day)}`));
  }
  return out;
}
