// Wiederherstellung bei Server/Seite-Abweichung (Review W-1): reiner Zustandsautomat, getestet.
//
//   idle ──Abweichung──▶ refetching ──/symbols geändert──▶ idle (weiter mit neuer Konfiguration)
//                          │   ▲                    └──unverändert──▶ blocked
//                          │   └─ weitere Abweichungen: nur gezählt (nie sofort blockieren)
//   blocked ──Abweichung nach ≥ RETRY_MS──▶ refetching (Sperre ist nicht endgültig)
//
// Abweichungen aus Antworten der ALTEN Konfiguration (cfg ≠ aktuelle) zählen nie – sie sind nach einem
// Wechsel erwartbar (Anfragen mit alter URL waren noch unterwegs).

export const RETRY_MS = 5 * 60_000;
/** Mindestabstand zwischen zwei /symbols-Neuladungen (gegen Schleifen, Review c). */
export const MIN_REFETCH_MS = 30_000;
/** Zeitgrenze für das Neuladen selbst (Review d). */
export const REFETCH_TIMEOUT_MS = 10_000;

export type RecoveryState = 'idle' | 'refetching' | 'blocked';
export type Action = 'refetch' | 'ignore';

export class MismatchRecovery {
  state: RecoveryState = 'idle';
  /** während eines Neuladens eingegangene, ignorierte Abweichungen (Anzeige/Tests) */
  ignored = 0;
  private blockedAt = 0;
  private lastRefetchAt = -Infinity;

  /** Eine Abweichung wurde erkannt; `responseCfg` = Kachelkonfiguration der Anfrage, `cfg` = aktuelle. */
  onMismatch(responseCfg: number, cfg: number, now: number): Action {
    if (responseCfg !== cfg) {
      this.ignored++;
      return 'ignore';
    }
    if (this.state === 'refetching') {
      this.ignored++;
      return 'ignore';
    }
    if (this.state === 'blocked' && now - this.blockedAt < RETRY_MS) return 'ignore';
    if (now - this.lastRefetchAt < MIN_REFETCH_MS) {
      this.ignored++;
      return 'ignore';
    }
    this.state = 'refetching';
    this.lastRefetchAt = now;
    return 'refetch';
  }

  /** Ergebnis des Neuladens: `changed` = Konfiguration/Symbol hat sich geändert. */
  onRefetched(changed: boolean, now: number): void {
    if (changed) this.state = 'idle';
    else {
      this.state = 'blocked';
      this.blockedAt = now;
    }
  }

  /** Neuladen selbst schlug fehl (Netz): wie unverändert behandeln, später erneut. */
  onRefetchFailed(now: number): void {
    this.onRefetched(false, now);
  }

  /**
   * Review a: eine Sperre läuft nach RETRY_MS von selbst ab (der Controller stellt dafür einen Timer;
   * im Kerzenmodus kämen sonst nie wieder Anfragen und damit nie eine neue Abweichung). Liefert true,
   * wenn entsperrt wurde.
   */
  expire(now: number): boolean {
    if (this.state !== 'blocked' || now - this.blockedAt < RETRY_MS) return false;
    this.state = 'idle';
    return true;
  }

  get blocked(): boolean {
    return this.state === 'blocked';
  }
}

/**
 * Review c: Hat sich die Kachelkonfiguration geändert? Nur tileConfigVersion und tiles zählen – nicht
 * dataTo oder andere Felder, die sich auf einem Live-Server laufend ändern.
 */
export function tileConfigChanged(
  a: { tileConfigVersion: number; tiles: Record<string, Record<string, number>> } | undefined,
  b: { tileConfigVersion: number; tiles: Record<string, Record<string, number>> } | undefined,
): boolean {
  if (!a || !b) return a !== b;
  if (a.tileConfigVersion !== b.tileConfigVersion) return true;
  return canonical(a.tiles) !== canonical(b.tiles);
}

function canonical(t: Record<string, Record<string, number>>): string {
  return JSON.stringify(
    Object.keys(t)
      .sort()
      .map((tf) => [
        tf,
        Object.keys(t[tf]!)
          .sort()
          .map((r) => [r, t[tf]![r]]),
      ]),
  );
}
