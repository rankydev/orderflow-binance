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
  `tileConfigVersion`; die Fixture-API tut das bereits (der Client braucht n, um Kachelindizes zu berechnen).
- Kachel über der harten Grenze (60 000 Zellen): `422` mit JSON `{error}` (Client markiert die Kachel als
  abgelehnt, zeichnet dort Kerzen und fragt sie nicht erneut an).
