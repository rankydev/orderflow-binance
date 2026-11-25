-- Nachschärfung der API-Rolle nach dem Review (W4b, W4d).
--
-- work_mem: Tagesprofile über ~166 Tage mit Offset liefen beim Standard 4 MB in 5 Batches auf die
-- Platte, mit 32 MB nicht. 16 MB je Plan-Knoten bei Pool 4 begrenzt die API auf ≈ 64 MB je Knoten.
ALTER ROLE of_api SET work_mem = '16MB';

-- Die API liest nur Symbole, Tagesstände/Qualität, Footprint-, Bar- und Kline-Tabellen. Manifest
-- (raw_file, raw_day), Migrationsliste und Verifier-Läufe braucht sie nicht.
REVOKE SELECT ON raw_file, raw_day, schema_migrations, verify_run FROM of_api;
