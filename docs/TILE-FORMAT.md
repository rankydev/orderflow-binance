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

## Kachellänge (Abweichung von KONZEPT §5.3; Nutzerentscheide 2026-11-24 und 2026-11-25)

§5.3 leitet n aus dem **Median** der Zeilen je Bar ab. Gemessen (BTCUSDT 2026-11-20…22) ergab das Kacheln bis
107 000 Zellen. Die erste Ersatzregel (Maximum über die ganze Historie) entfernte wegen eines einzigen echten
Ausreißers (2026-08-19 15:27, 1m-Kerze 67 859 → 70 450 USDT) die Zeilengrößen unter 5 USDT für alle Zeiträume.
Seit 2026-11-25 gilt (Interimsregel; die bessere Lösung bleibt der offene Entwurfspunkt am Ende):

```
w        = R · tick_ref_units
rows(d)  = max über die Bars des tf am UTC-Tag d von  floor(high/w) − floor(low/w) + 1
Ref      = P95 von rows(d) über die Referenztage = der (⌊N/20⌋ + 1)-größte Wert unter N Tagen
           (N < 20: das Maximum). Referenztage: alle unveränderlichen Tage (data_day.immutable);
           gibt es keinen, alle Tage mit Daten.
m        = ceil(1,5 · Ref)                      (Sicherheitszuschlag TILE_ROWS_MARGIN)
n        = clamp(2^floor(log2(30 000 / m)), 32, 1024), dann halbiert (nicht unter 32), solange
           (größte Tageszeilenzahl der Quelltabelle + Bar-Tabelle, über alle Tage) × n · tf in Tagen
           > 300 000 (Quellzeilengrenze je Kachel, OF_API_MAX_TILE_SOURCE_ROWS; enger als die
           1,5 Mio. der Profile, §1.4)
angeboten nur, wenn 32 · m ≤ 60 000 und die Quellzeilengrenze je Kachel auch bei diesem n gilt
```

- **Garantie:** **Jede ausgelieferte Kachel hat ≤ 60 000 Zellen.** Der Server zählt die Zellen jeder Kachel
  (Ergebnis der Abfrage) und liefert eine Kachel darüber nie aus, sondern antwortet für **diese eine Kachel** mit
  **422** und `{ "error", "reason": "tile_cells_exceeded", "cells", "limit": 60000, "suggestR" }` (`suggestR` =
  nächstgröbere angebotene Zeilengröße dieses tf oder `null`), `Cache-Control: no-store`, ohne ETag. Die
  Ablehnung ist nie ein 500, löst keine Neuberechnung der Konfiguration und kein 409 aus; `tiles` und
  `tileConfigVersion` bleiben unverändert. Betroffen sein können nur Kacheln über Tagen oberhalb des P95 und
  über nicht finalen Tagen. Richtwert ohne Ausreißer: Zellen ≤ n · m ≤ 30 000 (bei n = 32: ≤ 60 000).
- **Gemessen (BTCUSDT, 167 Tage, exakte Zählung über die gesamte Historie, `apps/api/bench/tile-cells.ts`):**
  für alle 77 angebotenen (tf, R) 0 Kacheln über 30 000 und 0 über 60 000; größte Kachel 12 811 Zellen (30m,
  R = 20). Neu angeboten gegenüber der Maximum-Regel: 1m R = 10 und 20, 3m/5m/15m/30m R = 20; für viele
  bestehende (tf, R) ist n doppelt so groß.
- **Quellzeilengrenze je Kachel (2026-11-25):** 300 000 statt 1,5 Mio., damit jede angebotene Kachel auch
  auf dem 2-vCPU-VPS im Budget (p95 ≤ 250 ms warm) bleibt. Gemessen fiel damit nur 1d R = 50 heraus (≈ 325 000
  geschätzte Zeilen aus `fp_1h_b10` schon bei n = 32, p95 ≈ 100 ms auf dem Mac); bei 3m R ≥ 1 000 und 4h
  R ≥ 2 000 halbiert sich n von 1 024 auf 512. Die Bedingung ist wie die übrige Regel
  deterministisch (größte Tageszeilenzahl über alle gespeicherten Tage × feste Kachelspanne); ein Tag mit mehr
  Zeilen kann eine Kombination aus dem Angebot nehmen (neue `tileConfigVersion`). Profile und `/bars` behalten
  die Grenze 1,5 Mio. (`OF_API_MAX_SOURCE_ROWS`).
- **Stabilität:** Nicht finale Tage (der laufende Tag, ab P2 provisorische Live-Minuten) zählen nicht, damit sich
  `tiles` nicht im Tagesverlauf ändert. Ein zusätzlicher oder neu importierter Referenztag verschiebt `Ref`
  höchstens um einen Rang (zum benachbarten Wert der sortierten Tagesmaxima, oder um N/20 einen Rang weiter);
  `tiles` und damit `tileConfigVersion` können sich also höchstens einmal je Import bzw. je Tag ändern, der
  unveränderlich wird, nie im Wechsel innerhalb eines Tages. Die Regel ist deterministisch (gleiche Daten →
  gleiche Version, auch nach Neustart).
- **Neuberechnung:** nach jeder Änderung einer Tagesversion (Statistik je Tag aus `bar_*`, im Speicher). Ändert
  sich ein n oder das Angebot, ändert sich `tileConfigVersion`; da `cfg` Teil der Kachel-URL ist, sind alle Caches
  für die neue Konfiguration getrennt.
- **Veraltete `cfg`:** **409** + `{ error, tileConfigVersion }`; der Client lädt einmal `/symbols` neu.
- **Antworten auf `/footprint`, die der Client unterscheiden muss (für den Web-Autor):**

  | Status / Körper | Bedeutung | endgültig? | Empfehlung |
  |---|---|---|---|
  | 422 **ohne** `reason` | (tf, R) wird nicht angeboten | für diese `cfg` ja | nicht anfragen; nach `/symbols` richten |
  | 422 `reason: "tile_cells_exceeded"` (`cells`, `limit`, `suggestR`) | diese eine Kachel hat > 60 000 Zellen | nein, nur für diese Kachel und den Datenstand | Zeitraum mit `suggestR` laden, s. u. |
  | 422 `reason: "tile_source_rows_exceeded"` (`rowsEstimate`, `limit`, `suggestR`) | diese eine Kachel überschreitet die Quellzeilengrenze (ungewöhnlich schwerer laufender/neuer Tag) | nein, wie oben | wie oben |
  | 409 + `tileConfigVersion` | `cfg` veraltet | – | `/symbols` neu laden (einmal je Welle) |
  | 503 + `Retry-After` | Überlast, Import-Sperre, Datenbank weg, Versionsstand veraltet; auch von `/symbols` | nein | nach `Retry-After` wiederholen |

  `suggestR` ist die nächstgröbere **angebotene** Zeilengröße desselben tf oder `null` (keine gröbere). Sie hat
  ein eigenes n und damit eigene Kachelindizes: der Client lädt die Kacheln von `suggestR`, die den Zeitraum der
  abgelehnten Kachel überdecken (`tileIndexAt(t, n_suggest, tfSec)` für Anfang und Ende), zeichnet diesen
  Zeitraum mit den gröberen Zeilen und einem Hinweis („Zeilengröße hier vergröbert") und lässt das globale R und
  Auto-R unverändert. Ist `suggestR` `null`, bleiben dort Kerzen. Abgelehnte Kacheln tragen
  `Cache-Control: no-store` und keinen ETag: der Client muss Wiederholungen selbst drosseln (heute
  REJECT_TTL = 5 min; das bleibt richtig). Das heutige Verhalten (Kachel abgelehnt, Kerzen, Wiederholung nach
  5 min) ist zulässig, die Vergröberung die Empfehlung.

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

**Minuten ohne eigene Trades:** `/bars` und `/footprint` enthalten nur Bars aus eigenen aggTrades (`bar_*` bzw.
`fp_*`), **nie** aus Klines abgeleitete Bars. Minuten ohne aggTrades – auch echte Lücken eines `final_bad`-Tages wie
2026-10-27 00:02–00:30 UTC – fehlen in **beiden** Antworten (keine Füll-Bars mit Menge 0, keine Kline-Bars). Die
Zeitachse des Clients ist indexbasiert, solche Minuten erscheinen dort zusammengeschoben; die Kennzeichnung ist
Aufgabe des Qualitätsbands (`/api/v1/quality`, später).

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

**Cache-Header:** finale Kacheln (`final = true`) `Cache-Control: public, max-age=604800` (eine Woche, **ohne**
`immutable`; Review W5, siehe „Festlegungen der API") und `ETag: "<dataVersion>"`; nicht finale
`Cache-Control: no-cache` (+ ETag, 304 erlaubt). `/symbols`: `no-cache`.

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
  Speicher gehalten (Bars ≤ 1d überqueren keine Tagesgrenze); ändert sich eine Tagesversion, wird nur dieser Tag
  neu berechnet.
- **Angeboten** wird (tf, R) für alle Zeitrahmen aus KONZEPT §5.2 (1m … 1d) und R auf der Leiter bis
  10 000 Ticks mit `R · tickRefUnits ≥ tickUnits`, nach der Regel im Abschnitt „Kachellänge" (P95 der
  Tagesmaxima, Zellregel, Quellzeilengrenze je Kachel 300 000). Für eine angebotene Kombination gibt es nie ein 422 wegen der
  Quellzeilen; ein 422 mit `reason = "tile_cells_exceeded"` betrifft nur die einzelne Ausreißer-Kachel.
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
  zweitem Vite-Server); im Betrieb `OF_API_CORS_ORIGINS` (Liste oder `*`) – oder gleicher Ursprung hinter nginx,
  dann ist kein CORS nötig. Exponiert `ETag`, `Retry-After`, `X-Cache`. Jede Antwort trägt
  `X-Content-Type-Options: nosniff` und `X-Cache` (`hit`, `miss`, `shared` = an eine laufende gleiche Berechnung
  angehängt, `revalidated` = 304). Diagnose-Header `X-Source` (Quelltabelle), `X-Rows-Estimate` (geschätzte
  Quellzeilen) und `Server-Timing` nur mit `OF_API_DIAG_HEADERS=1` (Standard aus: sie verraten Tabellennamen und
  DB-Zeiten).
- **Browser-Cache (Review W5):** finale Antworten `Cache-Control: public, max-age=604800` – eine Woche, nicht
  `immutable`. Danach revalidiert der Browser mit `If-None-Match`; stimmt die `dataVersion` noch, antwortet die
  API mit 304 ohne Datenabfrage. Ein Neuimport eines bereits finalen Tages (neue Binance-Datei, Historien-
  reparatur) ändert die `dataVersion`, nicht die URL; er ist damit nach höchstens einer Woche sichtbar (sofort mit
  der Live-Invalidierung aus §5.4 in P2 oder einem Datenzähler in der URL).
- **Server-Cache und Revalidierung (Review W1):** Die API prüft `If-None-Match` gegen die `dataVersion` aus ihrer
  Tagesversionstabelle (Katalog), **bevor** sie die Datenbank fragt: Treffer → 304 ohne Datenabfrage und ohne
  Platz im Gleichzeitigkeitslimit. Fehler (400/404/409/422) werden vorher entschieden; ein `If-None-Match`
  ändert sie nie in ein 304. `If-None-Match: *` ergibt nur dann 304, wenn für diese Version eine erfolgreiche
  Antwort im Server-Cache liegt (sonst wird gerechnet; eine abgelehnte Kachel bleibt 422). Auch nicht finale Antworten liegen im Server-Cache, unter ihrer `dataVersion`
  (fehlende Tage gehen als „-" ein), höchstens `OF_API_NONFINAL_TTL_MS` (Standard 10 s) lang und höchstens mit
  25 % der Cache-Größe (sie verdrängen keine finalen Einträge; abgelaufene werden beim Einfügen weggeräumt);
  gleichzeitige gleiche Anfragen teilen eine Berechnung. Der Browser bekommt für nicht finale Antworten weiterhin
  `no-cache`.
- **Aktualität von 304 und Cache-Treffern:** Der Katalog liest `data_day` alle `OF_API_POLL_MS` (Standard 1 s).
  Bei gesundem Katalog ist ein Versionswechsel daher spätestens nach `OF_API_POLL_MS` + Dauer einer
  Aktualisierung sichtbar (warm einige ms; nach einem Import zusätzlich die Neuberechnung der Statistik des
  geänderten Tages, ≈ 0,1 s; beim Start ≈ 1 s für 167 Tage). Scheitert die Aktualisierung an einem
  Verbindungsverlust, antworten 304 und Cache-Treffer höchstens `OF_API_STALE_AFTER_MS` (Standard 30 s) lang
  auf dem letzten bekannten Stand; danach antworten alle Datenendpunkte und `/symbols` mit **503** +
  `Retry-After: 5` (jede solche Anfrage stößt sofort eine neue Aktualisierung an), bis eine wieder gelingt.
  Schließt die Aktualisierung gar nicht ab (hängende Verbindung; eigenes Zeitlimit max(10 s, 3 ·
  Statement-Zeitlimit)), gilt dasselbe ab 3 · `OF_API_STALE_AFTER_MS`. Scheitert sie nur an Sperren oder
  Zeitlimits eines laufenden Imports, bleibt der letzte Stand gültig (Daten ändern sich erst mit dessen Commit):
  die API bedient weiter, Health meldet `degraded`. Eine berechnete Antwort trägt immer die `dataVersion` ihres eigenen Snapshots.
- **Bestätigt für den Web-Client:** (1) `tileConfigVersion` bleibt eine sichere Ganzzahl (Hash < 2^47, derzeit
  14 Stellen); (2) eine Footprint-Kachel und `/bars` über denselben Zeitraum mit derselben Datenlage enthalten
  identische Bars mit identischem `buyQ + sellQ` je Bar (eine Funktion, ein Snapshot je Antwort); (3) `/bars`
  gibt im Header exakt das angefragte `from`/`to` zurück, auch wenn `to` hinter `dataTo` liegt (der Abschnitt
  enthält dann nur Bars < `dataTo`).

## Stats-Spalten (optional, `stats=1`)

`/bars` und `/footprint` liefern mit dem Parameter `stats=1` zusätzlich diese `x.`-Spalten (Länge = `nBars`,
gleiche Reihenfolge wie `time`; Decoder und Clients ohne Kenntnis ignorieren sie). Ohne `stats` hat jede
Antwort dasselbe Format wie bisher; `dataVersion`/ETag ändern sich mit dieser Version einmalig für alle
Antworten (die Eingabe des Hashes enthält jetzt den stats-Schalter), danach wieder nur mit den Daten. `stats` ist Teil des Cache-Schlüssels und der `dataVersion`;
`tileConfigVersion` bleibt unberührt.

| Spalte | Typ | Inhalt (KONZEPT §3.5; Teilbars i = Minuten bzw. Stunden der Bar, d_i = buy − sell, P_{i−1} = Σ_{k<i} d_k) |
|---|---|---|
| `x.maxDelta` | f64 Lots | max_i (P_{i−1} + run_max_i) – höchstes laufendes Delta in der Bar |
| `x.minDelta` | f64 Lots | min_i (P_{i−1} + run_min_i) |
| `x.cotHigh` | f64 Lots | DeepCharts „COT High": Delta seit die Bar ihr **Low** gebildet hat: j = **erste** Teilbar mit low_j = Bar-Low, d_from_low_j + Σ_{i>j} d_i |
| `x.cotLow` | f64 Lots | „COT Low": dasselbe mit dem **High** (j = erste Teilbar mit high_j = Bar-High, d_from_high) |
| `x.trades` | i32 | Σ `kline_1m.trades` der Minuten der Bar (Binance-Zählung, nicht aggTrades) |

- Berechnet mit `composeBars` aus `@orderflow/core` (derselbe Code wie im Importer für `bar_1h`/`bar_1d`) aus den
  Teilbars der gröbsten passenden Bar-Tabelle (`bar_1m` für 1m…30m, `bar_1h` für 1h…4h, `bar_1d` für 1d); exakt.
  Belegt durch Brute-Force-Tests aus `bar_1m` für jeden Zeitrahmen (Testdatenbank) und eine unabhängige
  SQL-Rechnung auf echten Daten (`apps/api/bench/stats-check.ts`, BTC und ETH: 13 104 Bars, 0 Abweichungen).
- **`x.trades`, zwei Fallen:** An Lückentagen kann `x.trades` einer größeren Bar die Summe der `x.trades` ihrer
  1m-Bars übersteigen: Minuten, die in `bar_1m` fehlen (keine eigenen Trades), haben trotzdem eine Kline mit
  Trades und zählen in die größere Bar. Und die Spalte **fehlt** (nie 0), wenn der Zeitraum zu breit ist.
- **`x.trades` nur, wo billig:** wenn die geschätzten `kline_1m`-Zeilen des Zeitraums ≤ 100 000 sind (bei BTC:
  1m…1h-Abschnitte zu 1 000 Bars und alle Footprint-Kacheln bis ≈ 69 Tage Spanne; nicht für 2h-/4h-/1d-Abschnitte
  zu 1 000 Bars). Fehlt die Spalte, ist die Anzahl nicht geliefert (nicht 0). Mit einer Spalte `kline_trades` in
  `bar_1m`/`bar_1h`/`bar_1d` (Importer) wäre sie überall billig.
- Größe: +36 B je Bar (4 × f64 + i32); bei Footprint-Kacheln gegenüber den Leveln (28 B je Level) gering.

## Inkonsistente Lesestände (503, nie 500)

`convert_to_rowstore` (Dekomprimieren eines Chunks vor einem Tagesersatz im Backfill) ist für Leser mit älterem
Snapshot nicht MVCC-sicher: sie sehen den Chunk danach leer. Eine REPEATABLE-READ-Transaktion nimmt ihren
Snapshot mit der ersten Abfrage, **vor** dem Planen, in dem Timescale die Chunks sperrt (nachgewiesen: läuft die
Konvertierung schon, wartet der Leser und liest danach mit altem Snapshot 0 Zeilen). Daher:

- Vor jeder Lesetransaktion ermittelt die API die Chunks der gelesenen Zeiträume (Katalogabfrage, autocommit)
  und sperrt sie mit `LOCK TABLE … IN ACCESS SHARE MODE` als **erster** Anweisung der Transaktion. `LOCK` ist
  eine Utility-Anweisung und nimmt keinen Snapshot; der Snapshot entsteht erst mit der folgenden Abfrage, also
  nach dem Erhalt aller Sperren. Garantie: Keine Konvertierung eines gelesenen Chunks kann zwischen Snapshot und
  Lesen committen – eine laufende wird abgewartet (bis `OF_API_LOCK_TIMEOUT_MS`, dann Wiederholung/503), eine
  spätere wartet auf den Leser. Ein Chunk, der erst nach der Katalogabfrage entsteht, ist nicht gesperrt (neue
  Chunks sind Rowstore; für ihn greift die Leerprüfung unten).
- Verteidigung in der Tiefe: Bars ohne Level, Level ohne Bars und ungleiche Summen gelten als inkonsistent;
  ebenso ein **leerer** Ausschnitt (je UTC-Tag; bei Profilen der ganze Zeitraum bzw. jeder Tag), der eine voll
  überdeckte UTC-Stunde enthält, für die gespeichert ist, dass sie Minuten mit Trades hat. Maßstab ist die
  Katalogstatistik „Minuten mit Trades je Tag und Stunde" (`bar_1m`), gezählt im gesperrten Snapshot ihrer
  Tagesversion und nur verwendet, wenn diese Version der des Lese-Snapshots gleicht – keine Schätzung, keine
  Schwelle. Echte Lücken (Börsenausfall, der unfertige Live-Tag, unvollständig importierte Tage) haben in ihren
  Stunden 0 Minuten und bleiben gültige leere Antworten (200). Inkonsistent → Wiederholung mit neuem Snapshot →
  **503 + `Retry-After: 2`** (`no-store`, nicht gecacht). Betrifft es nur unveränderliche Tage, gilt es
  zusätzlich als Datenfehler: laut protokolliert, Health `degraded`, in `/quality` unter `apiDataErrors`; ohne
  Wiederholung verfällt die Meldung nach einer Stunde.
- Deadlock (`40P01`) und Serialisierungsfehler (`40001`) werden mit neuem Snapshot wiederholt, danach 503 +
  `Retry-After: 2`; erschöpfter Shared Memory/Sperrtabelle (`53200`) sofort 503 + `Retry-After: 5`.
- `stats=1` antwortet ebenso mit 503 statt mit einem Teilergebnis, wenn eine Teilbar fehlt oder nicht zur Bar
  passt.

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
