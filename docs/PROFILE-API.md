# Volume-Profile- und Qualitäts-API (Version 1)

Konkretisiert KONZEPT §5.5 (`profile`, `profiles/daily`, `quality`), §6.3 (Volume Profile) und §4.9
(Qualitätsanzeige). Implementiert in `apps/api/src/routes/profile.ts` und `routes/status.ts`; Antworttypen und
Prüffunktionen für Client und Tests in `packages/core/src/profile/` (`RangeProfileResponse`,
`DailyProfilesResponse`, `checkRangeProfile`, `checkDailyProfiles`, `profileMarks`). Allgemeine Regeln (Fehler-
form `{error}`, `Retry-After`, CORS, `ETag`/304) wie in [`TILE-FORMAT.md`](TILE-FORMAT.md).

## Endpunkte

| Endpunkt | Parameter | Liefert |
|---|---|---|
| `GET /api/v1/profile` | `sym`, `from`, `to`, `R`, `va`? | ein Profil über `[from, to)` |
| `GET /api/v1/profiles/daily` | `sym`, `from`, `to`, `R`, `offsetH`?, `va`? | ein Profil je Tag in `[from, to)` |
| `GET /api/v1/quality` | `sym`, `from`, `to`, `shift`?, `issuesFrom`? | Zustand und Qualität je UTC-Tag, Issue-Minuten |

Parameter (strikt geprüft; unbekannte, doppelte oder leere Parameter → 400; Zahlen nur in kanonischer
Dezimalform):

- `sym`: Symbol aus `/symbols` (unbekannt → 404).
- `from`, `to`: ms UTC, `[from, to)`. Range-Profil: **minutengenau** (Vielfache von 60 000; KONZEPT §6.3
  „auf Minuten gerundet"), höchstens 3 660 Tage. Tagesprofile: Tagesgrenzen mit Offset, d. h.
  `(from − offsetH·3 600 000)` und `(to − offsetH·3 600 000)` sind Vielfache von 86 400 000; höchstens 400 Tage.
- `R`: Zeilengröße in Ticks auf der Leiter {1, 2, 5}·10^k, 1 ≤ R ≤ 1 000 000 und `R · tickRefUnits ≥ tickUnits`
  (sonst 400). Profil-R ist unabhängig vom Footprint-R (§6.3) und muss **nicht** in `/symbols.tiles` stehen.
- `va`: Value-Area-Anteil in Prozent, ganzzahlig 1…100, Standard 70.
- `offsetH`: Tagesgrenze in ganzen Stunden, −23…23, Standard 0 (§6.3: UTC 00:00 + Offset).
- `shift` (nur `quality`): `1` = auch `shift`-Minuten auflisten (Standard `0`: sie gelten als korrekt und
  werden nur gezählt, §4.9).

## Zeilen

Wie bei den Kacheln: Zeile r = `floor(px / w)` mit `w = R · tickRefUnits` (price_unit), untere Kante `r · w`.
Ein Profil ist **dicht**: `buy[i]`, `sell[i]` sind die Lots der Zeile `rowLo + i`, von der Zeile des tiefsten bis
zu der des höchsten gehandelten Preises; innere Zeilen ohne Trades stehen als 0 da (deshalb gibt es kein
`row`-Array). Erste und letzte Zeile haben immer Volumen. Total = `buy + sell`, Delta = `buy − sell`.

## Antwort `profile` (JSON)

```json
{
  "format": 1, "kind": "profile",
  "sym": "BTCUSDT", "R": 100, "priceDecimals": 2, "qtyDecimals": 3, "tickRefUnits": 10,
  "from": 1793836800000, "to": 1793923200000, "va": 70,
  "dataVersion": "PoQ4hnqs3uYhjzzZeBiGc3sgcF-", "final": true,
  "sources": [ { "table": "fp_1d_b100", "from": 1793836800000, "to": 1793923200000 } ],
  "sourceRowsEstimate": 575,
  "profile": {
    "rowLo": 7515, "buy": [0, 3141, …], "sell": [12, 2210, …],
    "poc": 7552, "vah": 7580, "val": 7531, "deltaPoc": 7547,
    "buyQ": 41234567, "sellQ": 40987654,
    "notional": "818765432109876543",
    "low": 7515030, "high": 7629990
  }
}
```

- `poc`, `vah`, `val`, `deltaPoc` sind **absolute Zeilenindizes**; `null`, wenn das Profil leer ist (bzw.
  `deltaPoc`, wenn jedes Delta 0 ist).
- `buyQ`, `sellQ`: Summen der Zeilen (Lots, ganzzahlig < 2^53).
- `notional`: Σ px·lots in price_unit·qty_unit als **Dezimalstring** (überschreitet 2^53 schon an einem Tag;
  nie per `Number()` lesen, sondern `BigInt(notional)`). VWAP = notional / (buyQ + sellQ) in price_unit; erst bei
  der Ausgabe in Gleitkomma umrechnen.
- `low`, `high`: tiefster/höchster gehandelter Preis in price_unit.
- `sources`: die gelesenen Teilbereiche und Tabellen (Transparenz der Quellenwahl), `sourceRowsEstimate`: die
  vor der Ausführung geschätzten Quellzeilen.
- Leeres Profil (keine Trades im Bereich): `rowLo = null`, leere Arrays, alle Marken `null`, Summen 0,
  `notional = "0"`.

## Antwort `profiles/daily` (JSON)

Gleicher Umschlag mit `"kind": "profiles/daily"` und `"offsetH"`, statt `profile` ein Array `days`:

```json
"days": [ { "day": "2026-11-05", "from": 1793836800000, "to": 1793923200000, "final": true,
            "dataVersion": "…", "rowLo": …, "buy": […], "sell": […], "poc": …, "vah": …, "val": …,
            "deltaPoc": …, "buyQ": …, "sellQ": …, "notional": "…", "vwap": 61234.567891,
            "low": …, "high": … } ],
"emptyDays": [],
"missingDays": ["2026-06-08", "2026-06-09"]
```

**Regeln für `from`/`to`/`offsetH`:** `offsetH` ganzzahlig in −23…23 (praktisch reichen −11…+12); `from` und `to`
sind Tagesgrenzen mit diesem Offset, d. h. `(from − offsetH·3 600 000)` und `(to − offsetH·3 600 000)` sind
Vielfache von 86 400 000 und `from − offsetH·3 600 000 ≥ 0`; höchstens 400 Tage; sonst 400.

- Tag d überdeckt `[d·86 400 000 + offsetH·3 600 000, (d+1)·86 400 000 + offsetH·3 600 000)`; `day` ist das
  **UTC-Datum von d**. Beispiel `offsetH = −7`: `"day": "2026-11-05"` reicht von 2026-11-04 17:00 bis
  2026-11-05 17:00 UTC (Sitzung wird nach dem Tag benannt, in dem sie endet); `offsetH = +2`: 2026-11-05 02:00
  bis 2026-11-06 02:00.
- **Maßgeblich sind `from`/`to`** jedes Tages; `day` ist nur die Bezeichnung (bei `offsetH ≠ 0` deckt sich der
  Zeitraum nicht mit dem UTC-Datum).
- `days`: nur Tage mit Trades, aufsteigend. Die übrigen Tage des Bereichs stehen in **`emptyDays`** (Daten
  gespeichert, aber keine Trades – ein echtes leeres Profil) oder **`missingDays`** (keine gespeicherten Daten:
  Lücke, Zukunft, vor dem Datenbeginn – kann sich durch Import/Backfill füllen).
- `final` je Tag: alle UTC-Tage, die der Tag überdeckt (bei Offset ≠ 0 zwei), sind unveränderlich.
  **`dataVersion` je Tag** hängt nur von diesen UTC-Tagen und den Parametern (R, va, Offset) ab – gleich in jeder
  Anfrage, die den Tag enthält. Ein Client kann finale Tage damit dauerhaft halten, auch wenn die Antwort
  insgesamt (`final` des Umschlags) wegen eines nicht finalen Tages `false` ist.
- `vwap` (auch beim Range-Profil): notional / (buyQ + sellQ) in price_unit, auf 6 Nachkommastellen exakt per
  Ganzzahldivision, `null` ohne Volumen; nur zur Anzeige (exakt ist `notional`).

## Kennzahlen (KONZEPT §6.1, einheitlich für Bars, Profile, TPO)

- **POC**: Zeile mit größtem Volumen `buy + sell`; Gleichstand → näher an der Mitte des Zeilenbereichs
  (`rowLo + (n − 1)/2`), dann die tiefere.
- **Delta-POC**: Zeile mit größtem `|buy − sell|`, gleiche Gleichstandsregel (eigene Festlegung; §6.1 nennt
  keine).
- **Value Area**: klassisches Market-Profile-Paarverfahren. Start beim POC; Summe der zwei nächsten Zeilen
  oberhalb gegen die Summe der zwei nächsten unterhalb (fehlt eine Seite, nur die andere; am Rand ggf. nur eine
  Zeile); das größere Paar wird ganz aufgenommen, Gleichstand → oben; bis `100 · kumuliert ≥ va · gesamt`
  (ganzzahlig). `vah`/`val` = oberste/unterste Zeile. Implementierung `valueArea` in
  `packages/core/src/profile/value-area.ts` (Property-Tests T6: enthält POC, zusammenhängend, ≥ va, deterministisch).

## Genauigkeit und Quellenwahl

Ergebnisse sind **exakt**: gleich der Summe über `fp_1m` im Zeitraum, neu auf R gebinnt – keine Näherung.
Begründung: Der Zeitraum wird von grob nach fein zerlegt (ganze UTC-Tage aus `fp_1d_*`, wenn ein gespeicherter
1d-Bin R teilt; ganze Stunden aus `fp_1h_*`; dann 15 min, 5 min, Minuten aus `fp_15m_b100`, `fp_5m_b10`,
`fp_1m_b10`/`fp_1m`), je Zeitraster die Tabelle mit dem größten Bin, der R teilt. Jede Quellzeile liegt ganz in
genau einem Teilbereich, und `floor(floor(px/b)·b / w) = floor(px/w)` für `b | w`. Die Rollups sind beim Import
nachweislich gleich der Summe über `fp_1m` (Importer-Tests, Verifier). Tagesprofile werden je Tag zerlegt; bei
`offsetH ≠ 0` liegt keine Tagesgrenze auf UTC-Mitternacht, also nie aus `fp_1d_*` (§6.3), sondern aus `fp_1h_*`
bzw. für R ∈ {1, 2, 5} aus `fp_1m`.

Zusätzlich prüft die API jede Antwort: Σ Zeilen = Σ der Bar-Tabellen (`bar_1d`/`bar_1h`/`bar_1m` über dieselben
Teilbereiche) für buy und sell; eine Abweichung ist ein Datenfehler und ergibt 500 statt einer falschen Antwort.
Nachgewiesen in `apps/api/test/api.int.test.ts` (zufällige, nicht ausgerichtete Bereiche über Chunk- und
Tagesgrenzen, alle Quelltabellen, Offsets 0/+3/−7, Notional > 2^53).

## Grenzen (KONZEPT §1.4, §5.1)

- **Quellzeilen ≤ 1,5 Mio.**, geschätzt **vor** der Ausführung aus einer Statistik je (Tabelle, UTC-Tag)
  (Zeilen des Tages × überdeckter Anteil). Darüber **422**
  `{ "error", "reason": "profile_source_rows", "rowsEstimate", "limit", "suggestR": <R> | null }` mit der
  kleinsten Leiterstufe > R, die unter der Grenze liegt. Die Schätzung ist etwa proportional zur Länge des
  Zeitraums: ein Zeitraum ≈ `limit / rowsEstimate` × so lang passt bei gleichem R.
- **Zeilen ≤ 60 000** (Range: Zeilenzahl; Tagesprofile: Summe über alle Tage), bestimmt aus dem Preisbereich der
  Bar-Tabellen vor der Level-Abfrage. Darüber **422**
  `{ "error", "reason": "profile_rows", "rows", "limit", "suggestR" }` (ein kürzerer Zeitraum hilft nur, wenn
  er den Preisbereich verkleinert).
- Alle Grenzen stehen maschinenlesbar in `/symbols` unter `limits` (`profile.maxRows`, `profile.maxSourceRows`,
  `profile.maxR`, `profile.maxRangeDays`, `profile.maxDailyDays`, `profile.offsetH`, `profile.va`; außerdem
  `tiles`, `bars`, `quality`). R liegt auf der Leiter {1, 2, 5}·10^k mit `R · tickRefUnits ≥ tickUnits`.
- Richtwerte BTC: R ∈ {1, 2, 5} liest `fp_1m` (≈ 0,45–0,9 Mio. Zeilen je Tag) → ein bis zwei Tage; R = 10…50
  liest `fp_1h_b10` → einige Monate; R ≥ 100 auf ganzen Tagen `fp_1d_b100` → Jahre. Für ein Auto-R (§6.3:
  ≈ 120 Zeilen Range, ≈ 60 je Tag) aus `low`/`high` eines vorhandenen Profils oder der Bars wählen und bei 422
  `suggestR` übernehmen.

## Caching

`final = true` nur, wenn jeder überdeckte UTC-Tag existiert und `data_day.immutable` ist; dann
`Cache-Control: public, max-age=604800` (eine Woche, ohne `immutable`, danach Revalidierung per ETag) und
`ETag: "<dataVersion>"`, sonst `no-cache` (+ ETag). `dataVersion` = Hash über die Versionen der überdeckten Tage
und die Parameter. Die API beantwortet ein passendes `If-None-Match` mit 304, ohne die Datenbank zu fragen; im
Server-Cache liegen finale Antworten bis zur Verdrängung, nicht finale höchstens 10 s
(`OF_API_NONFINAL_TTL_MS`), jeweils unter ihrer `dataVersion`.

## Antwortgröße und Format (Begründung JSON)

JSON statt Binärformat: Profile sind klein (Auto-R ≈ 60–120 Zeilen; hart ≤ 60 000), das dichte Format braucht
kein `row`-Array, Notional muss ohnehin als exakter Dezimalstring reisen, und Web-Client und Verifier lesen es
ohne Decoder. Gemessen (BTC, echte Daten, 2026-11-24): Oktober bei R = 100 (≈ 1 200 Zeilen) 16,8 kB roh /
8,2 kB gzip; ein Tag bei Auto-R = 500 ≈ 1 kB; 30 Tagesprofile bei R = 500 ≈ 27 kB roh / 12 kB gzip.

## Antwort `quality` (JSON)

```json
{
  "schema": 1, "kind": "quality", "sym": "BTCUSDT",
  "from": 1793836800000, "to": 1794096000000,
  "days": [ { "day": "2026-10-27", "from": 1793059200000, "state": "final_bad", "immutable": true,
              "version": 4, "source": "vision", "stale": false, "edgePending": false,
              "edgeFirstPending": false, "edgeLastPending": false, "deepCheck": null, "rows": 1712345,
              "minutes": { "exact": 1180, "shift": 230, "mismatch": 1, "missing": 29, "gap": 0 } } ],
  "issues": [ { "ts": 1793059320000, "kind": "missing", "dQ": 1234, "dB": 567 } ],
  "issuesIncludeShift": false, "issuesTruncated": false
}
```

- `from`/`to` der Antwort sind auf ganze UTC-Tage erweitert (alle Tage, die die Anfrage berührt; **≤ 400** je
  Anfrage, sonst 400).
- `days`: nur Tage mit `data_day`-Zeile; ein fehlender Tag hat keine Daten (Lücke). `state` ∈ provisional,
  importing, provisional_import_failed, final_ok, final_bad; `immutable` wie oben; `minutes` sind die Zähler des
  Kline-Abgleichs (§4.6, `null` vor dem ersten Abgleich).
- `issues`: Minuten mit `kind` ∈ mismatch, missing, gap (und shift mit `shift=1`), aufsteigend nach `ts`;
  `dQ`/`dB` = Abweichung Volumen/Taker-Buy gegen die Kline in Lots. **Höchstens 5 000 Einträge je Antwort**,
  geschnitten an einer Minutengrenze. Weitere Seiten: Parameter `issuesFrom=<issuesNext>` (ms; Issues mit
  `ts ≥ issuesFrom`); `issuesNext` ist die erste ausgelassene Minute oder `null`, `issuesTruncated` =
  `issuesNext ≠ null`, `issuesFrom` in der Antwort ist der tatsächlich verwendete Beginn.
- Immer `Cache-Control: no-cache`. `ETag` = Hash über die Parameter und einen Fingerabdruck **aller**
  ausgelieferten Qualitätsfelder je Tag (Zustand, Version, Quelle, Flags, `deep_check`, Zähler) – so ändert sich
  die ETag auch ohne neue Datenversion (z. B. nach einer Tiefenprüfung). Die Issue-Minuten
  (`data_minute_issue`) sind nicht Teil des Fingerabdrucks: das gilt nur, solange sie ausschließlich in der
  Import-Transaktion entstehen, die auch `data_day` (Version, Zähler) ändert (heute der Fall). Wie bei den Kacheln: 304 ohne
  Datenabfrage, Server-Cache höchstens `OF_API_NONFINAL_TTL_MS` (10 s) lang, gleiche gleichzeitige Anfragen
  teilen eine Abfrage.
- `apiDataErrors`: Datenfehler, die die API seit ihrem Start auf unveränderlichen Tagen dieses Bereichs gefunden
  hat (Bars ohne Level, Summen ungleich; die betroffene Anfrage wurde mit 503 beantwortet):
  `[{ at, message, from, to }]`. Normal leer.
- Farbband nach §4.9: grün `final_ok`; gelb `provisional`, `provisional_import_failed`, `importing`,
  `edgePending`/`stale`; rot `final_bad` oder `minutes.gap > 0`.

## Fehler

`400` ungültige Parameter, `404` unbekanntes Symbol/Pfad, `422` Grenzen (mit `suggestR`), `503` Überlast,
Sperre durch einen laufenden Import, Abfragezeitlimit oder Datenbank nicht erreichbar (mit `Retry-After`,
wiederholbar).

400 und 404 sind für diese URL endgültig. **422 gilt nur für den aktuellen Datenstand:** die Schätzung der
Quellzeilen und der Preisbereich wachsen mit neuen Tagen bzw. ändern sich mit Neuimporten. Ein Client übernimmt
`suggestR` (oder wählt ein gröberes R) und fragt dieselbe URL frühestens nach einem neuen `/symbols`-Stand
(geändertes `dataTo`) erneut. Umgekehrt ist ein leeres Profil (200, `rowLo = null`) für einen Zeitraum ohne
Trades kein Endzustand: liegt der Zeitraum nicht vollständig in finalen Tagen (`final = false`), kann ein späterer
Import oder Backfill ihn füllen; der Client fragt dann wie bei jeder nicht finalen Antwort erneut.
