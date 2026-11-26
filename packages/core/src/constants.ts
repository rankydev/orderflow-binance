// Zeitkonstanten aus KONZEPT §3.3 (Produktregel Minutenzuordnung).
export const MINUTE_MS = 60_000;
export const DAY_MS = 86_400_000;

// Version der Berechnungsregeln; wird in raw_day/data_day.importer_version festgehalten (P1).
// 1 = P1: Minute nach T (§3.3), Kandidatenregel 59 900 ms (§4.6), Rollups §3.6, Digest ohne check_state.
// 2 = P5: Order-Regel v1 (§3.7), big_order ab symbol.big_floor_n, Ordersummen, Digest-Version 2.
export const RULES_VERSION = '2';
