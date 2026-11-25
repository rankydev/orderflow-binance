COMMENT ON COLUMN data_day.live_frozen IS NULL;
COMMENT ON COLUMN data_day.live_minutes IS NULL;
COMMENT ON COLUMN data_day.live_until IS NULL;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT ON TABLES FROM of_recorder;
DROP FUNCTION IF EXISTS of_recompress_chunk(regclass);
DO $$
DECLARE
  j record;
BEGIN
  FOR j IN
    SELECT job_id, config FROM timescaledb_information.jobs
     WHERE proc_name IN ('policy_compression', 'policy_columnstore') AND hypertable_schema = 'public'
       AND config ? 'recompress'
  LOOP
    PERFORM alter_job(j.job_id, config => j.config - 'recompress');
  END LOOP;
END
$$;
