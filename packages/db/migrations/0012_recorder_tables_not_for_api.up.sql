-- Die mit 0011 angelegten Recorder-Tabellen sind über die Standardrechte aus 0009 für of_api lesbar.
-- Die API-Rolle liest nur bewusst freigegebene Tabellen; ob die API ingest_status (Health, §2.5)
-- oder live_kline_check (Qualitätsanzeige, §4.9) liest, entscheidet die API mit einer eigenen
-- Freigabe. Bis dahin entzogen.
REVOKE SELECT ON ingest_status, live_kline_check, recorder_quality FROM of_api;
