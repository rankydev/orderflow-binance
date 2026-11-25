GRANT SELECT ON raw_file, raw_day, schema_migrations, verify_run TO of_api;
ALTER ROLE of_api RESET work_mem;
