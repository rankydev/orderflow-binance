DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'of_recorder') THEN
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM of_recorder';
    EXECUTE 'REVOKE ALL ON SCHEMA public FROM of_recorder';
    EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM of_recorder', current_database());
  END IF;
END
$$;
ALTER TABLE data_day DROP COLUMN IF EXISTS live_frozen;
