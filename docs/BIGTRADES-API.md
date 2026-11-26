# Big-Trades-API (Version 1)

Konkretisiert KONZEPT §5.5 (`bigtrades`) und §6.4 für die **absolute Schwelle** (Entscheidung 2026-11-26); das
Perzentil-Modell (`def`, `tiers`, `side_mode`) ist [später]. Implementiert in `apps/api/src/routes/bigtrades.ts`
(Abdeckung und Schätzung rein in `src/bigtrades-plan.ts`, SQL `queryBigOrders` in `src/queries.ts`); Format,
Encoder und Decoder mit allen Prüfungen in `packages/core/src/bigtrades/codec.ts` (`decodeBigTrades`, auch in
`@orderflow/core/browser`). Allgemeine Regeln (Fehlerform `{error}`, `Retry-After`, CORS, `ETag`/304,
`X-Cache`) wie in [`TILE-FORMAT.md`](TILE-FORMAT.md).

## Anfrage

`GET /api/v1/bigtrades?sym&tf&from&to&min` – strikt geprüft wie `/bars` (unbekannte, doppelte, leere,
nicht kanonische Parameter → 400).

| Parameter | Bedeutung |
|---|---|
| `sym` | Symbol aus `/symbols` (unbekannt → 404) |
| `tf` | Zeitrahmen der Bars, auf die die Marker gesetzt werden (`1m` … `1d`); bestimmt die Spalte `bar` und die Ausdünnung je Bar |
| `from`, `to` | ms UTC, `[from, to)`, an `tf` ausgerichtet, `to > from`, höchstens `limits.bigtrades.maxBars` (5 000) Bars. Empfohlen: dieselben Abschnitte zu 1 000 Bars wie `/bars` |
| `min` | Schwelle in **ganzen USDT**, `symbols[].bigTrades.minUsdt` ≤ `min` ≤ 10⁹. Geliefert werden Orders mit Notional ≥ `min` |

`/symbols` trägt je Symbol `bigTrades: { floorN, minUsdt, notionalDecimals }` oder `null` (keine
Untergrenze → Endpunkt 422 `not_available`) und `limits.bigtrades: { maxBars, maxRows, maxSourceRows,
maxMatchedRows, maxMinUsdt }`. `floorN` = `symbol.big_floor_n` (Notional in price_unit·qty_unit),
`minUsdt` = ⌈floorN / 10^notionalDecimals⌉ (BTCUSDT 500 000, ETHUSDT 250 000).

**Schwelle unter der Untergrenze wird abgelehnt, nicht angehoben** (422 `below_floor` mit `minUsdt`): eine
still angehobene Schwelle wäre eine andere Antwort als die angefragte; wie `/footprint` bei nicht angebotenem
(tf, R) entscheidet der Client nach `/symbols`.

## Antwort (`application/octet-stream`, Magic `OFB1`)

Container wie die Kacheln: Bytes 0–3 Magic `OFB1` (uint32 LE `0x3142464F`), 4–7 Headerlänge H (uint32 LE),
dann UTF-8-JSON auf `8 + H ≡ 0 (mod 8)` mit Leerzeichen aufgefüllt, dann die Spalten in der Reihenfolge von
`header.columns`, je 8-Byte-ausgerichtet, Little Endian, mit Nullbytes aufgefüllt, nichts danach. Ein
Kachel-Decoder lehnt die Antwort ab (anderes Magic).

```json
{
  "format": 1, "kind": "bigtrades", "sym": "BTCUSDT", "tf": "1h", "tfSec": 3600,
  "priceDecimals": 2, "qtyDecimals": 3, "tickRefUnits": 10, "notionalDecimals": 5,
  "from": 1788480000000, "to": 1792080000000,      // = Anfrage
  "minUsdt": 500000, "minN": 50000000000,          // minN = minUsdt · 10^notionalDecimals
  "maxRows": 20000, "total": 41210, "omitted": 21250, "k": 9,   // k null ⇔ omitted 0
  "coverage": [ { "from": …, "to": …, "status": "ok", "reason": null, "floorN": 50000000000, "final": true }, … ],
  "dataVersion": "…", "final": false, "n": 19960,
  "columns": [ { "name": "ts", "type": "f64", "length": 19960 }, … ]
}
```

Spalten (Länge `n`, aufsteigend nach `(ts, firstAggId)`, alle Werte ganzzahlig):

| Name | Typ | Inhalt |
|---|---|---|
| `ts` | f64 | Zeit T der Order in ms UTC (exakt) |
| `bar` | i32 | Beginn der `tf`-Bar in Sekunden: `floor(ts / 1000 / tfSec) · tfSec` (= `time` der Bar in `/bars`) |
| `side` | i32 | 1 = Käufer-Aggressor (buy), 2 = Verkäufer-Aggressor (sell) |
| `pxFirst`, `pxLast` | i32 | Preis des ersten / letzten aggTrades (Sweep-Spanne), price_unit |
| `qty` | f64 | Lots (qty_unit) |
| `notional` | f64 | Σ px · lots in price_unit · qty_unit (exakt < 2^53) |
| `aggN` | i32 | Anzahl aggTrades (Fill-Zahl mit „≈" zeigen, Order-Regel v1 ist heuristisch) |
| `firstAggId` | f64 | aggId des ersten aggTrades – stabiler Schlüssel der Order |

Darstellung ohne Gleitkommadrift: USDT = `notional / 10^notionalDecimals`, Menge = `qty / 10^qtyDecimals`, Preise
= `px / 10^priceDecimals` – als Ganzzahl + Dezimalstellen formatieren (z. B. `notional` als String, Komma
`notionalDecimals` Stellen von rechts). **VWAP** in price_unit = `notional / qty` (ein Bruch; als Zahl auf
≥ `priceDecimals` + 1 Stellen gerundet anzeigen); Marker-Position = (`bar`, VWAP).

### Abdeckung (`coverage`) – „keine Daten" ≠ „keine Big Trades"

Lückenlose Zerlegung von `[from, to)` an UTC-Tagen (Ränder = Anfrage), gleiche Nachbartage zusammengefasst:

| `status` | `reason` | Bedeutung | Zeilen |
|---|---|---|---|
| `ok` | `null` | alle Orders ≥ `min` gespeichert (`floorN` ≤ `minN`) | vollständig |
| `partial` | `floor_above` | Tag mit höherer Untergrenze `floorN` geschrieben: Orders in [`min`, floorN) fehlen | nur ≥ `floorN` |
| `none` | `digest_v1` | vor den Order-Daten geschrieben (Digest-Version 1), Neuimport ausstehend | keine |
| `none` | `no_day` | keine gespeicherten Daten (Lücke, Zukunft, vor Datenbeginn, Erstimport läuft) | keine |
| `none` | `no_floor` | ohne Untergrenze geschrieben (keine big orders gebildet) | keine |
| `none` | `unknown_totals` | laufender Tag, Vollständigkeit vom Recorder nicht nachgewiesen (`orders_n` NULL) | keine |

Zeilen gibt es **nur** in `ok`/`partial`-Bereichen (gespeicherte Zeilen eines `none`-Tages werden nicht
ausgeliefert). Der Client zeigt `none` als „keine Daten" (wie eine Lücke), `partial` mit Hinweis
„hier erst ab floorN". `final` je Bereich = alle Tage unveränderlich. Ein `ok`-Bereich mit `final = false`
(laufender Tag) enthält die bis jetzt gespeicherten Minuten; Minuten ohne eigene Trades fehlen wie in `/bars`.

### Ausdünnung und Grenzen

- Mehr als `maxRows` (20 000) Orders ≥ `min` im Bereich → je (`bar`, `side`) nur die **k größten** (Rang nach
  notional absteigend, dann ts, firstAggId), mit dem größten k, für das Σ min(Anzahl, k) ≤ maxRows; `total` =
  alle Orders ≥ `min`, `omitted` = total − n. Da maxRows ≥ 4 · maxBars, bleibt k ≥ 2: die Ausdünnung scheitert
  nie, ein 422 wegen der Antwortgröße gibt es nicht.
- **422 `matched_rows_exceeded`** (`rowsEstimate`, `limit` = maxMatchedRows 150 000, `suggestMinUsdt`): zu
  viele Orders ≥ `min` für Ranking/Sortierung. Schätzung aus der Katalogstatistik je Tag und Notional-Stufe
  (1-2-5 · 10^k USDT, 100 000 … 10⁹; exakt auf einer Stufe, sonst obere Schranke). `suggestMinUsdt` = kleinste
  Stufe > `min`, die passt (oder `null`). Client: Abschnitt mit dieser Schwelle laden und „Schwelle hier
  angehoben" zeigen, wie `suggestR` bei Kacheln.
- **422 `source_rows_exceeded`** (`rowsEstimate`, `limit` = maxSourceRows 5 Mio., `suggestTo`): zu viele
  gelesene Zeilen – unabhängig von der Schwelle, weil der Columnstore nur nach ts sortiert ist. `suggestTo` =
  größtes ausgerichtetes `to` ab `from`, das passt (oder `null`); Rest in Folgeanfragen.
- 422 `below_floor` (`minUsdt`, `floorN`), 422 `not_available`. Alle 422/400/404 mit `Cache-Control: no-store`,
  ohne ETag, endgültig für diese URL und diesen Datenstand.

### Caching und Versionen

`ETag` = `dataVersion` (Hash über die Versionen der überdeckten Tage, Parameter, `maxRows` und eine
Endpunkt-Build-Version; gelesen im selben Snapshot wie die Zeilen; die Orderfelder von `data_day` ändern sich
nur zusammen mit `data_day.version`). `RESPONSE_BUILD_VERSION` bleibt unverändert (neuer Schlüsselraum,
bestehende ETags unberührt). **`final`** = alle überdeckten Tage unveränderlich **und** mit Order-Daten (kein
`none`): dann `Cache-Control: public, max-age=604800`, sonst `no-cache` – ein `digest_v1`-Tag ist unveränderlich,
wird aber mit dem Neuimport Order-Daten bekommen und darf deshalb nicht eine Woche im Browser liegen.
304 vor der Datenabfrage, Server-Cache, gebündelte gleiche Anfragen und Live-Tag (jede Minute neue Version)
wie bei `/bars`. Lesen unter Chunk-Sperre (`LOCK TABLE` der big_order-Chunks vor dem Snapshot,
TILE-FORMAT.md „Inkonsistente Lesestände").

## Gemessen (2026-11-26, Mac, synthetisch: `apps/api/bench/bigtrades-plan.ts`)

400 Tage × 4 600 Orders (gemessen 2026-11-21: BTC 4 257, ETH 4 626 je Tag an der Untergrenze), Notional
Pareto ab 500 000 USDT (P(> 5 Mio.) ≈ 1,5 % wie gemessen), alle 14 Chunks komprimiert, min aus 3 Läufen:

| Abschnitt (1 000 Bars) | Tage | gelesen | ≥ 0,5 Mio. | ≥ 2 Mio. | ≥ 10 Mio. |
|---|---|---|---|---|---|
| 1m | 0,7 | 4 600 | 5 ms | 1 ms | 1 ms |
| 15m | 11 | 50 597 | 49 ms (50 597 → 19 008) | 6 ms | 2 ms |
| 1h | 42 | 193 195 | 179 ms (→ 18 144) | 16 ms (15 363) | 6 ms |
| 4h | 167 | 768 163 | 680 ms (→ 18 036) | 80 ms (61 980 → 18 036) | 23 ms (3 254) |
| 1d | 400 | 1 839 914 | 1 670 ms | 190 ms (147 728 → 20 000) | 55 ms (7 830) |

Plan (EXPLAIN ANALYZE, 4h, ≥ 10 Mio.): `ColumnarScan` je Chunk mit `Vectorized Filter (notional >= …)`, nur die
Chunks im Zeitraum (Chunk-Ausschluss über ts-Literale), ≈ 3,5 ms je 30-Tage-Chunk; Ranking übersprungen.
Kosten: Entpacken ≈ 30 ms je Mio. gelesener Zeilen, Ranking ≈ 0,9 µs je Treffer. Daraus die Grenzen
(≤ 150 + 135 ms; auf dem VPS mehr, dort nachzumessen). Kein Index und keine Migration nötig: auch mit
hoher Schwelle über 167 Tage bleibt die Abfrage bei 23 ms. Ein Minmax-Sparse-Index auf `notional` (bräuchte
eine Migration) ist nicht gemessen und brächte wenig: jede Charge von 1 000 Orders (≈ 5 h) enthält große
Orders. Bei dieser Verteilung gehen an der Untergrenze 1m/5m/15m-Abschnitte durch; 1h-Abschnitte
(≈ 193 000 Treffer) bekommen 422 mit `suggestMinUsdt` = 1 000 000, 4h mit 2 000 000, 1d (1 000 Tage) mit
5 000 000. (1m-Zeile: ein ganzer Tag statt 0,7.)
