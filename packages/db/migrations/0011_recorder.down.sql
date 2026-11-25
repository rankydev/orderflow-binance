DROP TABLE IF EXISTS recorder_quality;
DROP TABLE IF EXISTS live_kline_check;
ALTER TABLE data_day DROP COLUMN IF EXISTS live_minutes, DROP COLUMN IF EXISTS live_until;
DROP TABLE IF EXISTS ingest_status;
