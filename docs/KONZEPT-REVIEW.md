# Review: KONZEPT.md (Stand 2026-11-24)

Reviewer-Rolle: skeptischer Senior-Engineer, der nach diesem Dokument bauen muss. Grundlage: KONZEPT.md vollständig gelesen; externe Prüfungen siehe Abschnitt 4 (mit Grenzen).

## 1. Urteil

**Baubar nach Korrekturen.** Die Architektur trägt (Rohdateien als Quelle der Wahrheit, Integer-Preise, Single Writer, explizite Rollups, kachelbasierte Binär-API, Chartdaten außerhalb der Reaktivität). Vor Phase 1 müssen aber drei Dinge geändert werden:

1. **Der Kline-Abgleich ist nicht entscheidbar und kann echte Fehler verdecken.** Die Hypothese in §4.5 lässt sich mit den vorhandenen Daten nicht beweisen. Die `shift`-Klasse ist so weit gefasst, dass sie einen Off-by-one-Fehler an der Minutengrenze genauso einordnen würde wie die vermutete Eigenschaft der Quelle. Außerdem widerspricht die Abnahme von P1 (≥ 99 % `exact`) dem eigenen Audit (≈ 2,6 % abweichende Minuten).
2. **Backfill, Kompression und Plattenplatz sind nicht durchgeplant.** Ein Backfill von 692 Tagen läuft mit der beschriebenen Policy unkomprimiert voll (≈ 65 GB allein für `fp_1m`), und F1 (wo liegen die Rohdaten, wo läuft der Backfill) ist offen.
3. **P1 enthält Big-Trade-Daten, deren Parameter noch nicht feststehen.** Die Untergrenze soll „nach dem ersten Importmonat“ bestimmt werden (eine zirkuläre Abhängigkeit), F5 und F6 sind offen, und Notional-Werte als Float vertragen sich nicht mit „Verifier ohne Toleranz“ und „Re-Import bitgleich“.

---

## 2. Befunde

### Blocker (vor P1 beheben)

**B1 – §4.5/§4.6/§8 P1: Grenzverschiebungs-Hypothese nicht beweisbar, `shift`-Klasse maskiert Bugs, Abnahme widersprüchlich**
- *Problem:*
  - (a) Aus aggTrades allein lässt sich nicht zeigen, dass Fills eines aggTrades die Minutengrenze überspannen. Die Zeitstempel der einzelnen Fills fehlen.
  - (b) Die Bedingung „|Δ| ≤ Σ Menge im 100-ms-Fenster **um** die Grenze“ ist symmetrisch und erlaubt auch Einfach-Fills. Verschiebt die eigene Minutenzuordnung einen aggTrade mit T = k·60 000 fälschlich in die Vorminute, erfüllt das exakt die `shift`-Bedingung. Genau diesen Bug soll K4 aber finden.
  - (c) Die Toleranz „Trade-Count ≤ 3“ ist willkürlich.
  - (d) Die offizielle Doku sagt, dass Insurance-Fund- und ADL-Trades nicht in aggTrades aggregiert werden. Forenberichte von Binance-Mitarbeitern bestätigen Sprünge in den Trade-IDs (f/l) zwischen aufeinanderfolgenden aggTrades. Falls Klines diese Trades zählen, entsteht eine weitere systematische Abweichung (Count und eventuell Volumen), die weder `shift` noch Fehler ist und im Dokument nicht vorkommt. §9 nennt nur RPI.
  - (e) P1 verlangt „≥ 99 % Minuten exact“. Laut Audit weichen am 2025-11-01 aber 37 von 1 440 Minuten ab (2,6 %). Stimmt die Hypothese, zeigt auch der korrekte Aggregator ≈ 34 `shift`-Minuten pro Tag, und P1 scheitert definitionsgemäß. Die 10-%-Schwelle für `final_ok` in §4.6 passt wiederum nicht zu den 99 %.
- *Warum wichtig:* K4 ist die einzige externe Prüfung (Binance-Klines statt eigener Code). Ist sie weich, prüft nur noch der Verifier, der dieselbe Spezifikation umsetzt (siehe W7).
- *Änderung:*
  1. Die Hypothese in P1 mit dem **Vision-Datensatz `futures/um/daily/trades`** (einzelne Fills mit eigener Zeit; laut Binance-FAQ für USDⓈ-M ab 2020 verfügbar) an 3–5 Tagen entscheiden. Dazu Fills nach eigener Zeit pro Minute summieren und mit den Klines vergleichen, außerdem f/l-Lücken gegen die trades-Datei abgleichen (welche Trades fehlen in aggTrades, zählen Klines sie?).
  2. `shift` nur zulassen, wenn alle drei Größen (Volumen, Taker-Buy, Count) exakt gegen **eine** Nachbarminute aufgehen, der Überschuss in der **früheren** Minute liegt, und er aus aggTrades mit T ∈ [B − 100 ms, B) und l > f stammt (nur Mehrfach-Fills sind teilbar). Die Count-Abweichung muss ≤ Σ(l − f) dieser aggTrades sein.
  3. Die P1-Abnahme neu formulieren: „100 % der Minuten `exact` oder `shift` (enge Definition); 0 `mismatch`; Tagessummen exakt“. Den 99-%-Wert streichen.
  4. Eine Klasse `source_excluded` (Insurance/ADL) nur einführen, wenn die trades-Datei sie belegt.

**B2 – §3.9/§2.4/F1: Backfill sprengt die Platte, Kompression während des Backfills ungeregelt**
- *Problem:*
  - Unkomprimiert braucht `fp_1m` ≈ 60 B Heap plus ≈ 35 B PK-Index pro Zeile. Bei 650 Mio. Zeilen sind das ≈ 60–65 GB, dazu kommen WAL und Rollups. `add_compression_policy(..., '3 days')` komprimiert per Hintergrundjob; der Standard-Intervall der Policy liegt bei der halben Chunk-Länge. Ein Importer, der Tage im Minutentakt schreibt, läuft dem Job davon.
  - 7- und 30-Tage-Chunks werden beim sequenziellen Backfill teils schon komprimiert, während noch Tage in sie importiert werden. Das ergibt Inserts in komprimierte Chunks; Timescale rät bei Bulk-Backfill ausdrücklich, vorher zu dekomprimieren.
  - F1 entscheidet, ob der Backfill auf dem VPS (80 GB frei, davon 28–42 GB Rohdaten, wenn dort gehalten) oder auf dem Mac läuft. Das ist keine Detailfrage, sondern bestimmt den P1-Ablauf.
- *Änderung:*
  1. Backfill-Modus im Importer: Policies pausieren, Tage chunkweise in Zeitreihenfolge importieren, nach dem letzten Tag eines Chunks `compress_chunk` explizit aufrufen, danach die Policies wieder aktivieren.
  2. Vor dem Start freien Platz prüfen und bei < 15 GB abbrechen.
  3. F1 vor P1 entscheiden. Empfehlung: Backfill auf dem VPS mit Download → Import → Löschen pro Tag (Manifest bleibt in der DB). Alternativ Import auf dem Mac und Transfer per `pg_dump`/`pg_restore` mit `timescaledb_pre_restore()`/`post_restore()`.
  4. Die Backfill-Dauer auf dem VPS als eigenes Abnahmekriterium aufnehmen.

**B3 – §3.6/§3.7/§8: Order-Daten in P1 mit offenen Parametern; Float-Werte verletzen K7/K8**
- *Problem:*
  - (a) `big_floor_usd` soll erst „nach dem ersten Importmonat“ bestimmt werden, P1 importiert aber `big_order` für alle Tage. F5 und F6 sind offen.
  - (b) Die Bucket-Zuordnung arbeitet auf einem Float-Notional (Σ Preis·Menge). DuckDB summiert parallel in anderer Reihenfolge, deshalb landen Werte nahe an einer Bucketgrenze unterschiedlich. Gleichzeitig verlangt §4.7 „keine Toleranz“. Das gilt ebenso für `quote_vol` (double) und `notional real[]` (float32, nur ≈ 7 Stellen).
  - (c) Die Untergrenze von ≈ 1–2 % der Orders entspricht global etwa P98–P99. In ruhigen Wochen liegt das P99,5 des 7-Tage-Fensters leicht darunter, das Intervall ist dann ständig `incomplete`. Der Satz „alle Definitionen ≥ P99“ ist eine Annahme über künftige Wünsche des Nutzers.
- *Änderung:*
  1. Order-Merge, `size_hist_*` und `big_order` aus P1 nach P4 verschieben (Re-Import aus den Rohdateien ist laut §3.7 ohnehin billig). P1 wird kleiner.
  2. Notional ganzzahlig führen: `px · lots` als bigint in Einheiten von `price_unit·qty_unit` (BTC 10⁻⁴ USDT, max. ≈ 10¹³ pro Minute, passt in bigint). Bucketgrenzen pro Symbol als Integer-Tabelle. `quote_vol` ebenfalls als bigint, VWAP nur bei der Ausgabe berechnen.
  3. Die Untergrenze bestimmen als 0,5 × Minimum des stündlichen `rolling7d`-P99 über die gesamte Historie (zweiter Durchlauf über `size_hist_1h`, das ohne Untergrenze auskommt). Den resultierenden Speicheranteil messen und dokumentieren.

### Wichtig (vor der betroffenen Phase beheben)

**W1 – §3.4/§6.2: COT ist anders definiert als bei DeepCharts** (P3)
DeepCharts (Help Center „On Candle Stats“/„Deep Stats“) definiert: *COT High* = kumuliertes Delta „from the last time the current bar made a **low** until its Close“, *COT Low* = analog ab dem letzten neuen **High**. Das Dokument benennt es umgekehrt (COT High = Delta seit dem letzten Print am Bar-**High**). Außerdem misst es ab dem *letzten Print* auf dem Extrempreis, DC dagegen ab dem Zeitpunkt, an dem das Extrem *gebildet* wurde (erster Print auf dem finalen Extrem). Ein erneutes Antesten desselben Preises verschiebt den Startpunkt also nur im Dokument.
*Änderung:* DC-Semantik übernehmen oder bewusst abweichen und die Spalte umbenennen. Bei DC-Semantik in `bar_1m` `d_from_first_high`/`d_from_first_low` speichern und für die Komposition die **erste** Minute mit high_px_j = Bar-High nehmen. Die Komposition bleibt exakt (geprüft, siehe Abschnitt 3).

**W2 – §3.5/§5.2/§1.4: Footprints in 15m/30m treffen das 250-ms-Budget voraussichtlich nicht** (P3)
Nachgerechnet mit den Zeilenzahlen aus dem Dokument (BTC):

| Zeitrahmen | typisches Auto-R | Quelle | gelesene Zeilen pro Kachel |
|---|---|---|---|
| 15m | ≈ 100 Units | `fp_1m_b10` | 7 500 Minuten × 49 ≈ 370 k |
| 30m | 100–200 Units | `fp_1m_b10` | 15 000 Minuten × 49 ≈ 735 k |
| 4h | ≈ 500 Units | `fp_1h_b100` | 2 000 Stunden × 42 ≈ 84 k |

Für 15m und 30m gibt es keine Zwischenstufe, weil diese Zeitrahmen keine Vielfachen von 1h sind. Auf komprimierten Chunks mit 1,5 CPU sind 0,4–1,5 s zu erwarten; 4h ist unkritisch.
*Änderung:* Eine Rollup-Stufe `fp_5m_b10` und/oder `fp_15m_b100` vorsehen (wenige k Zeilen pro Tag, < 0,5 GB) und die Quellenwahl in §5.2 um diese Stufe erweitern. Benchmark wie in §9, aber mit diesen konkreten Fällen.

**W3 – §5.1/§7.2: Schutzgrenzen messen die Ausgabe, nicht den Aufwand; LOD ohne Zellbudget** (P2/P3)
- Die Zellgrenze (60 k) begrenzt die Antwort, nicht die gelesenen Zeilen. Ein Jahres-Range-Profil mit R = 50 Units (manuell) fällt auf `fp_1h_b10` zurück: 8 760 × 417 ≈ 3,6 Mio. Zeilen. Die Ausgabe ist klein, die Abfrage dauert Sekunden.
- Eine 1m-Kachel (500 Bars) mit R = 1 Tick ergibt ≈ 225 k Zellen und wird abgelehnt. Die Kachellänge ist fest statt zellbasiert.
- L2 erlaubt bs ≥ 6 px und rh ≥ 2 px. Auf 2 560 × 1 200 px sind das bis zu ≈ 400 Bars × 600 Zeilen sichtbar. T11 testet 60 k Zellen, die LOD-Regel begrenzt aber nichts. Genau hier droht wieder das Einfrieren wie bei PulseBot.

*Änderung:*
1. Guard zusätzlich auf geschätzte Quellzeilen (aus Zeilen/Tag der Quelltabelle × Zeitraum), mit Ablehnung und Vorschlag eines gröberen R.
2. Kachellänge pro (tf, R) so wählen, dass die erwartete Zellzahl ≤ 30 k ist.
3. Eine LOD-Bedingung „sichtbare Zellen ≤ N_max (z. B. 25 k)“ einführen, sonst gröberes R oder L1.
4. Text-Strings beim Laden der Kachel vorformatieren.
5. Das Stats-Grid bekommt ebenfalls eine eigene LOD (Text erst ab bs ≥ ≈ 30 px).

**W4 – §4.3/§3.8/§4.2: Übergabe live → final und Wiederanlauf unvollständig** (P1-Schema, P1b)
- Der Status `importing` (§4.3) fehlt in der Statusliste von `data_day` (§3.8).
- Unklar ist, was bei `final_bad` passiert. Schritt 6 löscht vor dem COPY, also würden gute Live-Daten durch eine schlechte Datei ersetzt. Gewünscht ist: Ersatz nur nach erfolgreicher Checksumme **und** erfolgreichem Parsen; sonst bleiben die provisorischen Daten, Status `provisional_final_failed`.
- Woher kennt der Recorder nach einem Absturz `last_a` und die halbe laufende Minute? Richtig ist: aus der Spool-Datei, nicht aus der DB. Die Spool muss dafür in zstd-Frames pro fsync geschrieben werden, sonst ist sie nach einem Absturz unlesbar.
- Werden `gap`-Minuten geschrieben? K6 verlangt: nein.
- Wer liefert den abgeschlossenen Bar an den Client? Die API rechnet ihn aus dem Feed, der Recorder schreibt ihn in die DB. Das sind zwei Rechnungen desselben Bars, entgegen „eine Quelle“.

*Änderung:*
1. Zustandsautomat für `data_day` mit allen Übergängen und Schreibrechten als Tabelle.
2. Recovery-Regel aus der Spool festlegen.
3. Der Recorder meldet „Minute M committed“ über den Feed, die API schickt dann den DB-Stand.

**W5 – §5.1/§5.4: „Datenversion“ undefiniert, formender Tag nicht cachebar** (P2)
ETag und Cache-Schlüssel hängen an einer Datenversion, die nirgends definiert ist. Die jüngste Kachel ändert sich jede Minute, und „beim nächsten regulären Kachel-Laden“ ist kein Zeitpunkt.
*Änderung:* `data_day.version` (Zähler, wird bei jedem Ersatz erhöht). Kachelversion = Hash der Versionen aller überdeckten Tage. Kacheln mit `provisional`-Tagen werden nie gecacht, der Client patcht sie nur per WS. Beim Wechsel auf `final_*` pusht die API ein Invalidierungsereignis.

**W6 – §3.2/§4.4: Tick-Historie nicht beschaffbar, R-Untergrenze fehlt** (P1)
`exchangeInfo` liefert nur die aktuelle Tickgröße, die Historie ab 2025 ist daraus nicht ableitbar. Für BTC und ETH ist das unkritisch, für spätere Symbole (häufige Tick-Anpassungen bei Altcoins) nicht.
*Änderung:*
- Der Importer ermittelt pro Tag empirisch das kleinste Preisinkrement (ggT der px-Differenzen) und schreibt es nach `symbol_tick_history`. `exchangeInfo` dient nur als Gegenprobe.
- `price_unit` bei Aufnahme eine Dekade feiner als den Tick wählen (int32 reicht für BTC bei 0,01 bis ≈ 21 Mio. $). Das vermeidet den Neuimport bei feinerem Tick.
- UI-R ≥ aktueller Tick in Units.
- `qty_unit` = min(LOT_SIZE, MARKET_LOT_SIZE stepSize).

**W7 – §4.7: Der Verifier ist nur teilweise unabhängig** (P1)
Er liest dieselben aggTrades nach derselben Spezifikation, und vermutlich schreibt derselbe KI-Agent beide Seiten. Fehler in der Interpretation (Seitenzuordnung, Minutenregel, Order-Merge) wiederholen sich darin. Ungeprüft bleiben außerdem Rollups, API-Ausgabe und Live-Pfad. Auch T10 rechnet in TS aus `fp_1m` und ist damit nicht unabhängig.
*Änderung:*
1. Verifier-Umfang v1: Minutensummen und Level-Summen pro (Minute, Preis) plus **alle Rollup-Tabellen** gegen DuckDB, dazu eine Stichprobe der API-Antworten (Binärformat in Python dekodieren, ≈ 50 Zeilen).
2. Level-Summen zusätzlich gegen den trades-Datensatz (andere Binance-Quelle als aggTrades) an den Golden-Tagen prüfen.
3. Order-Merge und Histogramm erst in P4.
4. DuckDB liest ZIP nicht nativ; Entpacken per `zipfile` in Arrow, im Dokument korrigieren.

**W8 – §3.7/F6: Order-Merge-Regel überschätzt, was aggTrades leisten** (P4)
Laut der COIN-M-Doku aggregiert Binance aggTrades über 100 ms bei gleichem Preis und gleicher Taker-Seite. Für USDⓈ-M konnte ich den Wortlaut nicht bestätigen (siehe Abschnitt 4). Ein aggTrade kann dann Fills mehrerer Taker enthalten, und der erste Level eines Sweeps kann an einem älteren aggTrade mit früherem T hängen. Die Regel trennt Sweeps also auch (nicht nur „seltenes Verschmelzen“).
*Änderung:* Den Fehler in P4 an 3 Tagen gegen den trades-Datensatz messen (gleiche Zeit + aufeinanderfolgende Trade-IDs + gleiche Seite = Match-Ereignis) und die Quote dokumentieren. Im Tooltip „Fills“ als „≈“ kennzeichnen. F6 ist damit eine Messfrage, keine Nutzerfrage.

**W9 – §2.5: Totmann und Watchdog** (P1b)
- Der externe Ping ist unbedingt formuliert („pingt alle 5 min“). Er muss **nur bei verifizierter Frische** gesendet werden (Recorder < 120 s, letzter Import ok). Dann deckt er VPS-Ausfall, Watchdog-Ausfall und toten Recorder gleichzeitig ab und hängt nicht am Ops-Kanal F2.
- Ist die DB down, startet der Watchdog den Recorder sinnlos neu, und für `systemctl restart` braucht er Rechte.
- Es fehlen Alarme für Plattenplatz (Spool, WAL, Backfill), Uhrzeit (chrony; der Minutenabschluss hängt an der Uhr), Postgres down und Fehlschläge des Importer-Timers.

*Änderung:*
1. Recorder mit `Type=notify` und `WatchdogSec=60`; `sd_notify WATCHDOG=1` nur bei frischen Trades. systemd startet dann selbst neu, der Timer-Watchdog dient nur noch dem Alarm.
2. Ein Health-Endpunkt aggregiert alles; der Totmann-Ping läuft nur bei `healthy`.
3. Plattenplatz- und NTP-Prüfung ergänzen.

**W10 – §2.4/F3: Exposition auf dem geteilten VPS** (P1b)
- Docker-Portfreigaben (`ports: 5432:5432`) umgehen UFW/iptables-Regeln. Postgres zwingend an `127.0.0.1:5432` binden oder nur über das Docker-Netz bzw. einen Unix-Socket ansprechen.
- Eigene DB-Rollen für recorder (nur Live-Tabellen), importer und api (read-only, wie geplant).
- Secrets in `EnvironmentFile` mit Rechten 0600 oder per systemd-Credentials, nicht im Repo.
- Basic-Auth gilt auch für `/api/v1/live` (WS-Upgrade). Im Browser prüfen; Fallback ist ein Session-Cookie, das nginx auf `/api` prüft.
- Stock-nginx unter Ubuntu 22.04 hat meines Wissens kein Brotli-Modul (nicht verifiziert). Fallback: gzip, oder die API komprimiert Kacheln aus finalen Tagen selbst vor und cacht sie.

**W11 – Backup/Restore fehlen als Abschnitt** (P1b)
Die DB ist aus den Rohdaten rekonstruierbar, das ist gut, aber nirgends als Restore-Pfad mit Zeitbedarf beschrieben. `kline_1m` (Referenz) liegt nur in der DB; ein späterer REST-Abruf ist nicht garantiert identisch.
*Änderung:*
1. Klines aus **Vision** (`futures/um/daily/klines/{SYM}/1m`, mit CHECKSUM) statt REST laden und wie aggTrades archivieren. Das ist reproduzierbar und kostet kein API-Gewicht.
2. Backup nur für kleine Tabellen (`data_day`, `data_minute_issue`, `verify_run`, `raw_file`) und die Konfiguration (täglicher `pg_dump` dieser Tabellen).
3. Restore-Probe (neue DB aus Rohdaten bis `final_ok`) als P1b-Abnahme mit gemessener Dauer.
4. Archiv auf dem Mac plus extern (F1) mit monatlicher SHA256-Prüfung.

**W12 – §8: Aufwand und Reihenfolge** (Planung)
Das erste sichtbare Ergebnis kommt erst nach P0 + P1 + P1b + P2 (16–24 PT). Der größte Performance-Beweis, der Footprint, kommt erst in P3. Die Schätzung von 33–49 PT enthält keine Puffer, keine UI-Grundstruktur (Toolbar, Einstellungen, Symbolwechsel, Tooltips, URL-Zustand), keine VPS-Härtung und kein Performance-Tuning nach den ersten Benchmarks. P3 mit allen Typen, Modi, Imbalances, Stats-Grid und Live ist mit 9–13 PT knapp.
*Meine Schätzung:* 55–75 PT.
*Änderung:* Vor P1b einen vertikalen Schnitt einschieben (siehe Abschnitt 5, Frage E2). Den Recorder erst danach bauen; PulseBot läuft bis dahin weiter.

### Hinweise (optional)

- **H1 §3.1:** Monats- und Tagesdateien sind zwei Codepfade samt Überlappungsprüfung. Nur Tagesdateien nutzen (≈ 700 Dateien pro Symbol sind unkritisch). Es gibt Forenberichte über fehlerhafte Monatsdateien (trades-Datensatz).
- **H2 §6.1 Imbalance:**
  - Die Randzeilen fehlen in der Spezifikation. Vorschlag: Buy-Imbalance in der untersten und Sell-Imbalance in der obersten Zeile gibt es nur mit `includeZero`.
  - Innere Zeilen ohne Trades zählen als 0.
  - Rechnung ganzzahlig (`100·b ≥ ratio_pct·s`).
  - Stacked: „aufeinanderfolgend“ = lückenlos benachbarte Zeilen; eine leere Zeile bricht die Folge.
- **H3 §6.5 TPO:** Die Initial Balance in Minuten (60) statt in Blöcken definieren; bei 5-min-Blöcken wären n = 2 nur 10 min. Zeilen eines Blocks = `floor(low/R) … floor(high/R)`, dann ist „beidseitig inklusive“ eindeutig.
- **H4 §6.3:** Klarstellen, dass das R von Profilen unabhängig von dem des Footprints ist. POC/VA im Profil und in den Bars dürfen also abweichen.
- **H5 §6.4:**
  - Für `how` fehlt der Datenanfang (die ersten N Wochen ohne Referenz), ebenso `rolling7d` in den ersten 7 Tagen. Dort `incomplete` setzen.
  - Kosten über einen Jahresbereich: ≈ 18 k Zeilen à 180 + 180 Werte (≈ 25 MB) aus `size_hist_1h`, unkritisch, aber messen.
- **H6 §3.9:** Die Timescale-API heißt inzwischen columnstore (`enable_columnstore`, `add_columnstore_policy`). Die alte API ist deprecated, funktioniert aber; das gewählte Image (`timescale/timescaledb:2.2x-pg17`) pinnen.
- **H7 §2.4:** Der Page-Cache des Postgres-Containers zählt gegen `mem_limit 2.5g`. `effective_cache_size=2GB` ist deshalb eher zu hoch. Die p95-Budgets getrennt für warm und kalt angeben.
- **H8 §7.3:** `setData` mit 50 k Kerzen kann allein > 50 ms dauern. Die Kerzen-Obergrenze auf ≈ 20 k senken oder `setData` nur beim Wechsel des Zeitrahmens aufrufen.
- **H9 §4.2:** Während des Parallelbetriebs mit PulseBot teilen sich beide Prozesse das REST-Gewicht pro IP (2 400/min). Den Fehlercode −4166 konnte ich nicht verifizieren.
- **H10 §2.6:** Keine Lizenzfrage, aber `lightweight-orderflow-charts` (MIT) habe ich nicht geprüft.

---

## 3. Geprüft und für solide befunden

- **WS-Pfad (§4.2):** `wss://fstream.binance.com/market/ws/<sym>@aggTrade` ist korrekt. aggTrade gehört laut der offiziellen „Important WebSocket Change Notice“ zu `/market`, unroutierte Verbindungen erhalten nur `/public`-Streams.
- **REST (§4.2):** Gewicht 20 pro Request ist plausibel; das Paging über `fromId` ist richtig. Laut Changelog-Snippet wurde der Lookback von `/fapi/v1/aggTrades` (gemessen ab jetzt) von 24 h auf 48 h erweitert; das passt zur 48-h-Annahme.
- **Lückenerkennung per aggId ist tragfähig, auch wenn Binance Kontinuität nicht garantiert.** Wer per `fromId = last+1` nachholt, beweist fehlende IDs als nicht existent (die erste gelieferte ID ist > last+1). Die Regel sollte so formuliert werden. Die im Risiko-Abschnitt erwogene **f/l-Kontinuität ist ungeeignet**: Laut Doku und Forum gibt es Sprünge in den Trade-IDs (Insurance/ADL).
- **Komposition von Max/Min-Delta (§3.4) mathematisch geprüft und korrekt:** Innerhalb eines aggTrades ist das laufende Delta monoton, Extremwerte liegen also an aggTrade-Grenzen. Die Exklusiv-Präfixsumme ist P_{i−1} = Σ_{k<i} d_k (im SQL `sum − d_i`). Die COT-Komposition ist für die gewählte Definition ebenfalls korrekt; die Definition selbst siehe W1.
- **Continuous Aggregates verwerfen ist richtig begründet:** Echtzeit-Aggregation ist seit 2.13 standardmäßig aus, und bei hierarchischen CAggs stoppt der rekursive Join an der ersten nicht-realtime Stufe (Tiger-Data-Doku).
- **DML auf komprimierten Chunks** wird seit 2.10/2.11 unterstützt; der Reimport-Pfad aus §3.9 funktioniert also. Für Bulk-Mengen empfiehlt Timescale, vorher zu dekomprimieren, wie geplant.
- **Größenschätzung nachgerechnet:** 940 k Zeilen/Tag × 692 Tage ≈ 650 Mio. Zeilen, daraus 3,9–6,5 GB; Rohdaten 28–42 GB; Summe der Limits 4,6 GB. Alles konsistent. Unsicher bleiben die 6–10 B/Zeile komprimiert (plausibel bei orderby `ts, px`, nicht gemessen). `size_hist_1m` halte ich eher für 0,4–1 GB (Arrays komprimieren schwach), das ist nicht kritisch.
- **Rollup-Zeilenzahlen** sind untereinander konsistent (implizite Ranges BTC: 1m ≈ 50 $, 1h ≈ 420 $, 1d ≈ 2 000 $). Die R-Leiter {1,2,5}·10^k ist mit den gespeicherten Bins kompatibel. 3-Monats- und Jahres-Profile sowie ein Jahr Tagesprofile (Offset 0) bleiben bei Auto-R unter 100 k gelesenen Zeilen.
- **Histogramm-Genauigkeit:** Die Bucketbreite 10^(1/20) = 1,122 ist korrekt, ebenso der Fehler der geometrischen Mitte ≤ ±5,9 %. Bei P99,97 über 7 Tage (≈ 6 Mio. Orders) liegen ≈ 2 000 Orders oberhalb, das ist statistisch tragfähig.
- **Quellenangaben im Dokument:**
  - lightweight-charts: Conflation in 5.1 ist standardmäßig aus und vorhanden; Panes gibt es seit v5.
  - TV: Der Footprint rechnet standardmäßig aus Intrabars mit Seitenzuordnung über die Richtung der Intrabars, wie im Dokument beschrieben.
  - DC: Low/Medium/Strong werden in der „Big Trades Analysis“ automatisch berechnet und nur wöchentlich/monatlich neu, also faktisch statisch.
- **Architekturprinzipien:** Single Writer, Replace statt Merge, Integer-Parser mit Fehler bei Off-Grid-Werten, Minute = f(T) unabhängig von der Reihenfolge, Chartdaten in nicht-reaktiven Typed Arrays, R ändert sich nie während einer Geste. Das adressiert die PulseBot-Fehler direkt.
- **Prozessanzahl:** Faktisch sind es 2 Daemons (recorder, api) und 3 Timer/CLIs. Das ist für das Ziel „Stream stirbt nicht durch die API“ angemessen. Python nur für den Verifier ist vertretbar, wenn sein Umfang wie in W7 begrenzt wird.

**Nicht prüfbar in dieser Sitzung:**
- Direkter Seitenabruf (WebFetch, curl) scheiterte an DNS. Es standen nur Websuche-Snippets der offiziellen Seiten zur Verfügung.
- Für USDⓈ-M nicht wörtlich bestätigt: die 100-ms-Aggregationsregel, der Fehlercode −4166, ob Klines RPI- oder Insurance-/ADL-Trades zählen und die exakte Spaltenliste der trades-Dumps.
- Bei TradingView nicht bestätigt: VA-Expansion in Paaren („TV dokumentiert es so“; die TV-Hilfe nennt nur Ziel = Σ × 70 %, VAH/VAL = äußerste einbezogene Zeile), Imbalance-Default 300 %, „Auto-R = 0,2 × ATR“ und ein „TV-Tick-Modus“ für den Footprint. Diese Angaben im Dokument als unbestätigt markieren.
- Delta-POC laut DC („größtes Netto-Delta“) nicht gefunden.
- `data/` nicht angefasst, PulseBot-Code nicht gelesen.

---

## 4. Kleinster Schnitt, der die beiden Top-Prioritäten beweist

Etwa 10–14 PT, vor P1b:
1. BTC, 2025-01-01 bis gestern.
2. Importer nur für `fp_1m`, `fp_1m_b10`, eine 5m/15m-Stufe, `fp_1h_b100`, `bar_1m/1h`.
3. Vision-Klines-Abgleich mit enger `shift`-Definition und trades-Dump-Beweis an 3 Tagen.
4. DuckDB-Verifier für Minuten-, Level- und Rollup-Summen.
5. API `bars` und `footprint` binär.
6. Frontend: Custom Series mit L1/L2/L3, Kacheln, LRU und Zellbudget.
7. Benchmark auf dem VPS: Pan über 3 Monate 15m-Footprint und 1 Jahr 1h-Kerzen, kalt und warm.

Nicht enthalten: Live, ETH, Profile, TPO, Big Trades, Stats-Grid.

---

## 5. Entscheidungen, die du treffen musst

- **E1 (F1, blockiert P1):** Wo liegt das Rohdatenarchiv dauerhaft, und wo läuft der Backfill (VPS mit Löschen nach Import, oder Mac mit DB-Transfer)? Soll eventuell Plattenplatz bzw. Object Storage dazugekauft werden?
- **E2:** Zuerst den vertikalen Schnitt aus Abschnitt 4 bauen (BTC, ohne Live, TPO, Big Trades) und erst danach den Rest, statt der Phasenfolge P1 → P1b → P2?
- **E3:** COT wie bei DeepCharts definieren (COT High = Delta seit dem neuen **Low**, ab Bildung des Extrems) oder die eigene, umgekehrt benannte Variante behalten?
- **E4:** Welche Big-Trade-Schwellen willst du realistisch nutzen? Nur ≥ P99, oder auch niedrigere Perzentile bzw. ruhige Phasen ohne `incomplete`? Das bestimmt die Untergrenze und damit den Speicher (≈ 1–2 % vs. ≈ 5 % der Orders).
- **E5 (F2, vor P1b):** Kanal für den Ops-Alarm und den externen Totmann-Dienst.
- **E6 (F3):** Basic-Auth über das öffentliche Internet reicht, oder lieber nur per VPN/Tailscale erreichbar (entfernt Auth-Fragen für den WS ganz)?
