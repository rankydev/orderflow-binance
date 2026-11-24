# Kachelformat (Binär, Version 1)

Konkretisiert KONZEPT §5.3/§5.6 dort, wo das Konzept die Feldanordnung offen lässt. Referenz-Implementierung
(Encoder, Decoder mit allen Prüfungen, Property-Tests): `packages/core/src/tile/codec.ts`,
`packages/core/test/tile.test.ts`. Die API muss **byte-identisch** dasselbe ausliefern; am einfachsten, indem sie
`encodeTile` aus `@orderflow/core` verwendet (Aufbau aus Rollup-Zeilen: `buildFootprintTile`, `buildBarsTile`).

## Aufbau

| Bytes | Inhalt |
|---|---|
| 0–3 | Magic `OFT1` (ASCII; als uint32 LE `0x3154464F`) |
| 4–7 | Länge `H` des JSON-Headers in Bytes, uint32 LE |
| 8 … 8+H | Header, UTF-8-JSON, rechts mit Leerzeichen aufgefüllt, sodass `8 + H` ein Vielfaches von 8 ist |
| danach | Spalten in der Reihenfolge von `header.columns`; jede beginnt 8-Byte-ausgerichtet, ist Little Endian und mit Nullbytes auf ein Vielfaches von 8 aufgefüllt. Nach der letzten Spalte folgt nichts. |

Typen: `i32` = Int32 LE, `f64` = Float64 LE. Mengen sind ganzzahlige Lots in `f64` (exakt bis 2^53).

## Header

```json
{
  "format": 1,
  "kind": "footprint",          // oder "bars"
  "sym": "BTCUSDT", "tf": "1m", "tfSec": 60,
  "R": 20,                       // Zeilengröße in Ticks; bei "bars" null
  "priceDecimals": 2, "qtyDecimals": 3, "tickRefUnits": 10,
  "from": 1795334400000, "to": 1795395840000,   // [from, to) in ms UTC, sekundengenau
  "tile": { "index": 29220, "n": 1024 },        // bei "bars" null
  "dataVersion": "…",            // Kachelversion (§5.4) = ETag
  "final": true,                 // alle überdeckten Tage final_* → unveränderlich
  "nBars": 1003, "nLevels": 48211,
  "columns": [ { "name": "time", "type": "i32", "length": 1003 }, … ]
}
```

Bei `footprint` gilt `from = index · n · tfSec · 1000` und `to = from + n · tfSec · 1000` (Kacheln an Vielfachen
von n·tf seit Epoch, §5.3). Bei `bars` ist `[from, to)` der angefragte Bereich.

## Spalten

Bars (beide Arten, Länge `nBars`, streng aufsteigend nach Zeit, nur Bars mit Trades):

| Name | Typ | Inhalt |
|---|---|---|
| `time` | i32 | Bar-Beginn in **Sekunden** UTC, Vielfaches von `tfSec`, in `[from, to)` |
| `open`, `high`, `low`, `close` | i32 | Preise in `price_unit` |
| `buyQ`, `sellQ` | f64 | Lots, Aggressor Käufer („Ask") / Verkäufer („Bid") |
| `buyA`, `sellA` | i32 | Anzahl aggTrades |

Level (nur `footprint`):

| Name | Typ | Länge | Inhalt |
|---|---|---|---|
| `levelOffset` | i32 | `nBars + 1` | Level von Bar i sind `[levelOffset[i], levelOffset[i+1])`; `levelOffset[0] = 0`, `levelOffset[nBars] = nLevels` |
| `lv.row` | i32 | `nLevels` | **Zeilenindex** `floor(px / (R · tick_ref_units))`, je Bar streng aufsteigend; untere Zeilenkante in price_unit = `row · R · tick_ref_units` |
| `lv.buy`, `lv.sell` | f64 | `nLevels` | Lots |
| `lv.buyA`, `lv.sellA` | i32 | `nLevels` | Anzahl aggTrades |

Nur Zeilen mit Trades werden übertragen (innere Zeilen ohne Trades fehlen; der Client behandelt sie als 0).

Zusatzspalten (Erweiterungspunkt, z. B. Stats-Felder oder Kline-Trade-Anzahl in späteren Phasen) tragen das
Präfix `x.` und eine beliebige Länge; Decoder ignorieren unbekannte `x.`-Spalten bzw. reichen sie durch. Andere
unbekannte Namen sind ein Fehler. Inkompatible Änderungen erhöhen `format`.

## Invarianten (Decoder lehnt sonst mit `TileFormatError` ab, Encoder ebenso)

- Länge exakt = Header + Σ ausgerichtete Spaltenlängen; Padding-Bytes sind 0; Magic, Format, Pflichtfelder.
- Zeit streng aufsteigend, ausgerichtet, in `[from, to)`; `0 < low ≤ open, close ≤ high`.
- Mengen ganzzahlig ≥ 0, Bar-Menge > 0; jede Footprint-Bar hat ≥ 1 Level.
- Zeilen je Bar streng aufsteigend und in `[floor(low/w), floor(high/w)]` mit `w = R · tick_ref_units`.
- Σ Level je Bar = Bar-Summen (`buyQ`, `sellQ`, `buyA`, `sellA`) – „Footprint-Summen = Bars".

## Entscheidungen, wo das Konzept offen war

- Magic + uint32-Headerlänge (statt nur Längenpräfix) für eine billige Formaterkennung.
- `levelOffset` mit `nBars + 1` Einträgen (CSR-Form) statt Offset je Bar ohne Endmarke.
- `row` als Zeilenindex statt `row_px` (kleinere Zahlen, Zeilenkante = `row · w`).
- Header-JSON enthält die Einheiten (`priceDecimals`, `qtyDecimals`, `tickRefUnits`), damit eine Kachel ohne
  `symbols`-Antwort interpretierbar ist (Verifier-Stichprobe §4.8).
- Größe: 28 B je Level + 44 B je Bar + ≈ 0,5–1 kB Header, wie in §5.6 abgeschätzt.
- Die Kachellänge `n` je (Symbol, tf, R) liefert `GET /api/v1/symbols` als `tiles[tf][R] = n` zusammen mit
  `tileConfigVersion` (Fixtures: 3); die Fixture-API tut das bereits (der Client braucht n, um Kachelindizes zu
  berechnen). **Nur angebotene Kombinationen** stehen in `tiles`; der Client fordert keine anderen an.

## Kachellänge (Abweichung von KONZEPT §5.3, Nutzerentscheid 2026-11-24)

§5.3 leitet n aus dem **Median** der Zeilen je Bar ab. Gemessen (BTCUSDT 2026-11-20…22) ergab das Kacheln bis
107 000 Zellen und 22 Kacheln über der harten Grenze. Neu (`tileBarsForMax` in `packages/core/src/tile/timeframes.ts`):

```
w       = R · tick_ref_units
maxRows = max über ALLE gespeicherten Bars des Symbols und tf von  floor(high/w) − floor(low/w) + 1
m       = ceil(1,5 · maxRows)                 (Sicherheitszuschlag TILE_ROWS_MARGIN)
n       = clamp(2^floor(log2(30 000 / m)), 32, 1024)
angeboten nur, wenn 32 · m ≤ 60 000           (sonst fehlt R für diesen tf in tiles[tf])
```

- **Referenzzeitraum:** die gesamte gespeicherte Historie des Symbols (nicht die letzten N Tage). Grund: ein
  Kurzzeitraum unterschätzt; gemessen max. Zeilen je 1m-Bar bei R = 5 an den drei Fixture-Tagen 1 110 / 1 755 /
  1 017 – n aus Tag 1 allein hätte an Tag 2 bei R = 50 und n = 256 Kacheln mit 45 056 Zellen ergeben.
- **Neuberechnung:** nach jedem Import eines Tages (billig: maxRows je (tf, R) als laufendes Maximum aus `bar_*`).
  Ändert sich ein n, wird `tileConfigVersion` um 1 erhöht. Da `cfg` Teil der Kachel-URL ist, sind alle Caches
  (Browser, nginx, Server-LRU) für die neue Konfiguration automatisch getrennt; alte Einträge laufen aus.
- **Garantie:** Zellen je Kachel ≤ n · m ≤ 30 000 (bei n = 32: ≤ 60 000), solange kein neuer Bar mehr als 1,5 × das
  Referenzmaximum an Zeilen hat; ein solcher Tag löst beim Import die Neuberechnung aus (neues n, neue Version).
- **Falls eine Kachel trotzdem die harte Grenze überschreitet** (z. B. zwischen Import und Neuberechnung): Der
  Server erhöht `tileConfigVersion` (neu berechnetes n) und antwortet auf die alte `cfg` mit **409** + JSON
  `{error}`. Der Client lädt daraufhin **einmal** `/symbols` neu und fährt mit der neuen Konfiguration fort;
  ändert sich dabei nichts, zeigt er dauerhaft „Server-Stand passt nicht zur Seite – Seite und Server neu laden".
  Kein 422 für diesen Fall (422 zeigt der Client für den Rest der Sitzung als Kerzen).

Mit den Fixtures (Zuschlag 1,5): 0 Kacheln über 30 000, 0 abgelehnt; feinste angebotene Zeilen 1m: R = 10 Ticks.

## Endpunkt-Verträge, die der Client voraussetzt (für die API; Review H2)

`GET /api/v1/symbols` → `application/json`:

```json
{
  "schema": 2,                      // Form dieser Antwort; der Client prüft sie
  "symbols": [
    {
      "name": "BTCUSDT",
      "priceDecimals": 2,          // price_unit = 10^-priceDecimals
      "qtyDecimals": 3,            // Lots: qty_unit = 10^-qtyDecimals
      "tickRefUnits": 10,          // ein Tick in price_unit; R wird in Ticks angegeben
      "tickUnits": 10,             // aktueller Tick in price_unit (R · tickRefUnits ≥ tickUnits)
      "dataFrom": 1795132800000,   // [dataFrom, dataTo) in ms UTC; der Client fordert nichts außerhalb an
      "dataTo": 1795392000000,
      "tileConfigVersion": 3,
      "tiles": { "1m": { "10": 32, "20": 32, "50": 64 }, "5m": { … } }   // nur angebotene (tf, R) → n
    }
  ]
}
```

`GET /api/v1/footprint?sym&tf&R&tile&cfg` → Kachel `kind = "footprint"`. `cfg` = `tileConfigVersion` (ändert sich n,
ändert sich die URL). Der Client prüft `sym`, `tf`, `R`, `tile.index`, `tile.n` gegen die Anfrage und verwirft
Abweichungen endgültig (keine Wiederholung). Leere Kachel (0 Bars) ist eine gültige Antwort.

`GET /api/v1/bars?sym&tf&from&to` → Kachel `kind = "bars"`. Der Client fragt nur **ausgerichtete Abschnitte zu
1 000 Bars** an: `from = c · 1000 · tfSec · 1000`, `to = from + 1000 · tfSec · 1000`; Header-`from`/`to` müssen genau
der Anfrage entsprechen. Ein Abschnitt kann leer sein.

Fehler und Statuscodes:
- (tf, R) nicht angeboten → **422** `{error}` (endgültig; kommt bei korrektem Client nicht vor).
- `cfg` ≠ aktuelle `tileConfigVersion` → **409** `{error}` (Server prüft `cfg`; Client lädt `/symbols` neu, s. o.).
- unbekanntes Symbol/tf, ungültige Parameter → **400**/**404**.
- `/bars` mit `to > dataTo` (letzter Abschnitt): normal beantworten; Header-`from`/`to` = **exakt die Anfrage**
  (der Abschnitt enthält nur Bars < dataTo). Dasselbe vor `dataFrom`.

Weiter: `400`/`404`/`422` (+ JSON `{error}`) sind endgültig für diese URL; `408`/`425`/`429`/`5xx` werden mit Backoff
wiederholt, `Retry-After` (Sekunden oder HTTP-Datum) wird beachtet. Kacheln mit `final = false` hält der Client
höchstens 60 s, danach fragt er neu (bis die Live-Invalidierung aus §5.4 in P2 kommt). ETag/304 sind erlaubt, werden
aber vom Client nicht vorausgesetzt.

**Cache-Header:** finale Kacheln (`final = true`) `Cache-Control: public, max-age=31536000, immutable` und
`ETag: "<dataVersion>"`; nicht finale `Cache-Control: no-cache` (+ ETag, 304 erlaubt). `/symbols`: `no-cache`.

**CORS:** Liegt die API auf einem anderen Ursprung als die Seite (`VITE_API_BASE`), muss sie für den Seiten-Ursprung
`Access-Control-Allow-Origin` setzen (nur GET, keine Credentials, keine besonderen Header). Gleicher Ursprung über
nginx ist der Normalfall (§2.4).

**Hinweise für die API-Implementierung:**
- `/symbols` trägt `"schema": 2`; der Client lehnt andere Werte mit sichtbarer Meldung ab. Inkompatible Änderungen
  der Form erhöhen `schema`.
- Notional-Summen überschreiten 2^53 (ETH-Tagesnotional ≈ 3,55·10^16): nie durch `Number()` leiten, in SQL/JS als
  `bigint` behandeln (die Kacheln enthalten kein Notional; relevant für Stats/VWAP).
- Int32-Spalten: `buildBarsTile`/`buildFootprintTile` prüfen jetzt jeden Wert auf den Int32-Bereich (`i32`) und
  werfen statt still abzuschneiden.

**Offen für die Live-Phase (P2, Review W3):** Bar-Abschnitte laufen im Client nie ab, `/symbols` und `dataTo` werden
nur beim Start bzw. bei einer Konfigurationsabweichung neu geladen, ein formender Bar fehlt; nicht finale
Footprint-Kacheln laufen nach 60 s ab. Invalidierung per Live-WS (§5.4) folgt mit dem Recorder.
