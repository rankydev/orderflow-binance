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

**Vorbedingung (der Client prüft sie):** Die Bars einer Footprint-Kachel sind für denselben Zeitraum und dieselbe
`dataVersion` genau die Bars von `/bars` – gleiche Zeiten (Bars ohne Trades fehlen in beiden) und gleiche
`buyQ + sellQ` je Bar. Auf finalen Daten ohne Lücken lädt der Client bei einer Abweichung Abschnitt und Kachel
einmal neu; wiederholt sich die Abweichung, lädt er `/symbols` neu und zeigt sonst „Server-Stand passt nicht zur
Seite". Auf nicht finalen Daten oder über Lücken wird nicht geprüft.

`GET /api/v1/bars?sym&tf&from&to` → Kachel `kind = "bars"`. Der Client fragt nur **ausgerichtete Abschnitte zu
1 000 Bars** an: `from = c · 1000 · tfSec · 1000`, `to = from + 1000 · tfSec · 1000`; Header-`from`/`to` müssen genau
der Anfrage entsprechen. Ein Abschnitt kann leer sein.

Fehler und Statuscodes:
- (tf, R) nicht angeboten → **422** `{error}` (endgültig; kommt bei korrektem Client nicht vor).
- `cfg` ≠ aktuelle `tileConfigVersion` → **409** `{error}` (Server prüft `cfg`; Client lädt `/symbols` neu, s. o.).
- unbekanntes Symbol/tf, ungültige Parameter → **400**/**404**.
- `/bars` mit `to > dataTo` (letzter Abschnitt): normal beantworten; Header-`from`/`to` = **exakt die Anfrage**
  (der Abschnitt enthält nur Bars < dataTo). Dasselbe vor `dataFrom`.

Weiter: `400`/`404`/`422` (+ JSON `{error}`) sind endgültig für diese URL; `409` (veraltete `cfg`) führt zu einem
einmaligen Neuladen von `/symbols` (Wiederholung frühestens nach 5 min); `408`/`425`/`429`/`5xx` werden mit Backoff
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

## Festlegungen der API (Klarstellungen zu diesem Vertrag)

Umgesetzt in `apps/api` (Katalog `src/catalog.ts`, Routen `src/routes/tiles.ts`); geprüft in
`apps/api/test/api.int.test.ts` mit den Prüfungen des Web-Clients.

- **`tileConfigVersion` ist eine undurchsichtige Ganzzahl** (1 … 2^47): ein Hash über die angebotenen
  `tiles[tf][R] = n` (plus eine Build-Version der Kacheln). Sie ändert sich genau dann, wenn sich ein n oder die
  Menge der angebotenen (tf, R) ändert, ist nach einem Neustart und auf einer zweiten Instanz mit denselben Daten
  gleich und wird **nur auf Gleichheit** geprüft (nicht „+1", nicht monoton). Kein Schreibzugriff nötig: das
  Maximum der Zeilen je Bar wird je UTC-Tag aus `bar_*` berechnet und mit `data_day.version` als Schlüssel im
  Speicher gehalten (Bars ≤ 1d überqueren keine Tagesgrenze, das Maximum über die Tage ist also exakt); ändert
  sich eine Tagesversion, wird nur dieser Tag neu berechnet (Abfrageintervall 1 s).
- **Angeboten** wird (tf, R) für alle Zeitrahmen aus KONZEPT §5.2 (1m … 1d) und R auf der Leiter bis
  10 000 Ticks mit `R · tickRefUnits ≥ tickUnits`, wenn die Zellregel oben gilt **und** eine Kachel die
  Quellzeilengrenze (1,5 Mio., §1.4) sicher einhält: (größte Tageszeilenzahl der gewählten Quelltabelle +
  Bar-Tabelle) × Kachelspanne in Tagen ≤ 1,5 Mio. Damit gibt es für eine angebotene Kombination nie ein 422.
- **`cfg` ist Pflicht** (fehlt → 400). Die 409-Antwort trägt die aktuelle Version:
  `{ "error": …, "tileConfigVersion": <aktuell> }`.
- **`final`** (Kacheln, Bar-Abschnitte, Profile) gilt genau dann, wenn jeder überdeckte UTC-Tag eine
  `data_day`-Zeile hat und `immutable` ist. Tage ohne Zeile (Lücken, Zukunft, vor dem Datenbeginn – ein Backfill
  kann sie noch füllen) sind nie final; Kacheln und Abschnitte, die über `dataTo` hinausreichen, sind daher
  `final = false`.
- **`dataVersion`** ist ein undurchsichtiger String (Hash über die Versionen der überdeckten Tage, die
  Anfrageparameter und bei Footprint die `tileConfigVersion`), gelesen im selben Snapshot (READ ONLY REPEATABLE
  READ) wie die Daten. Kacheln: `ETag` = `dataVersion`; `/symbols`: `ETag` = Hash der Antwort, `no-cache`.
- **`dataFrom`/`dataTo`**: erster bzw. letzter UTC-Tag mit `data_day`-Zeile (ein gerade erstmals importierter Tag
  im Zustand `importing` zählt noch nicht); innerhalb kann es Lücken geben. `tickUnits` = `min_step_units` des
  jüngsten Tages in `symbol_tick_history` (fehlt er: `tickRefUnits`).
- **`/bars`**: `from`/`to` am Zeitrahmen ausgerichtet, `to > from`, höchstens 5 000 Bars je Anfrage (der Client
  fragt 1 000 an). Bars höherer Zeitrahmen entstehen aus der gröbsten passenden Bar-Tabelle (`bar_1m` für
  1m…30m, `bar_1h` für 1h…4h, `bar_1d`); dieselbe Funktion liefert die Bars der Footprint-Kacheln, daher gilt die
  Vorbedingung Kachel = `/bars` auf demselben Datenstand per Konstruktion.
- Unbekannte, doppelte oder leere Query-Parameter → 400. Zahlen nur in kanonischer Dezimalform (`R=050` → 400).
- **503 + `Retry-After`** (wiederholbar): Überlast (Gleichzeitigkeitslimit/Warteschlange), Sperre durch einen
  laufenden Import nach begrenzter Wiederholung (`lock_timeout`), Abfragezeitlimit, Datenbank nicht erreichbar.
- **CORS**: Standard erlaubt nur Loopback-Ursprünge (`http://127.0.0.1|localhost|[::1]:<port>`, Entwicklung mit
  zweitem Vite-Server); im Betrieb `OF_API_CORS_ORIGINS` (Liste oder `*`). Exponiert `ETag`, `Retry-After`,
  `X-Cache`, `X-Source`. Diagnose-Header: `X-Cache` (hit/miss), `X-Source` (Quelltabelle), `X-Rows-Estimate`
  (geschätzte Quellzeilen), `Server-Timing`.
- Nach einem Neuimport eines bereits finalen Tages ändert sich `dataVersion`, nicht aber die Kachel-URL: Browser-
  Caches mit `immutable` behalten die alte Kachel, bis sich `cfg` ändert oder die Live-Invalidierung (§5.4, P2)
  kommt. Der Server-Cache ist davon nicht betroffen (Schlüssel enthält die `dataVersion`).

## Offener Entwurfspunkt für die API: Kachellänge je Zeitabschnitt (Review, nicht umgesetzt)

**Stand der API:** Die Statistik liegt bereits je UTC-Tag vor (`DayStats` in `apps/api/src/catalog.ts`); eine
Abschnittstabelle je Kalendermonat ist eine Aggregation dieser Tageswerte in `computeTiles` und eine zweite Form
von `tileSrc`/`tiles`. Umgesetzt ist die gesamthistorische Regel oben.


**Problem der jetzigen Regel:** Mit der gesamten Historie als Referenz und 1,5 × Zuschlag entfernt ein einziger
Ausreißer-Bar feine Zeilengrößen für **alle** Zeiträume. Gemessen an den Fixture-Tagen (max. Zeilen je 1m-Bar bei
R = 5 Ticks: 1 110 / 1 755 / 1 017): 1,5 · 1 755 · 32 = 84 240 > 60 000, also wird R = 5 Ticks auf 1m nicht mehr
angeboten. Ein einziger 1m-Bar mit 3 000 USD Spanne irgendwo in zwei Jahren machte ≈ 5 USDT zur feinsten 1m-Zeile.

**Vorgeschlagene Richtung:**
- n je **Zeitabschnitt** (z. B. Kalendermonat) bestimmen und in `/symbols` als Abschnittstabelle liefern:
  `tiles[tf][R] = [{ from, n }, …]` (aufsteigend; ein Abschnitt gilt bis zum nächsten `from`). Kachelindex relativ
  zum Abschnittsbeginn: Kachel k eines Abschnitts deckt `[from + k·n·tf, from + (k+1)·n·tf)`, letzte Kachel am
  Abschnittsende abgeschnitten.
- Angebotene (tf, R) **je Abschnitt** aus dessen Maximum × 1,5 ableiten; der Client wählt nur unter den im sichtbaren
  Abschnitt angebotenen R (über eine Abschnittsgrenze hinweg: das gröbere der beiden).
- `cfg` je (tf, R) statt je Symbol versionieren (z. B. `tiles[tf][R].cfg`), damit eine Neuberechnung nicht alle
  Caches ungültig macht; abgeschlossene Monate sind unveränderlich (ihr n ändert sich nie mehr).

**Abwägung:** + feine Zeilen bleiben in ruhigen Zeiträumen verfügbar, Ausreißer wirken nur in ihrem Monat, weniger
Cache-Invalidierung; − `/symbols` wächst (Tabelle je tf/R/Monat, ≈ 4 tf · 12 R · 24 Monate ≈ 1 200 Einträge, als JSON
≈ 30–50 kB, gzip ≈ 5 kB), Kachelgeometrie wird abschnittsabhängig, Kacheln an Monatsgrenzen sind kürzer.

**Was sich im Client ändern würde:** `wantedTiles` rechnet Kachelindizes je Abschnitt (Abschnitt per binärer Suche
über `from`), der Renderer schlägt die Kachel je Bar über (Abschnitt, k) nach; `availableR` hängt vom sichtbaren
Bereich ab (Auswahl und Auto-R nur über die dort angebotenen R); die Footprint-URL trägt die `cfg` des (tf, R);
die Querprüfung und der 409-Pfad bleiben gleich.
