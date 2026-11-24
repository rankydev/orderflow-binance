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

export type RecoveryState = 'idle' | 'refetching' | 'blocked';
export type Action = 'refetch' | 'ignore';

export class MismatchRecovery {
  state: RecoveryState = 'idle';
  /** während eines Neuladens eingegangene, ignorierte Abweichungen (Anzeige/Tests) */
  ignored = 0;
  private blockedAt = 0;

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
    this.state = 'refetching';
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

  get blocked(): boolean {
    return this.state === 'blocked';
  }
}
