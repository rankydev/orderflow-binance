-- Auf der QUELLE (Mac) ausgeführt von deploy/transfer-db.sh (nur lesend). Erzeugt roles-source.sql:
-- Anlage bzw. Angleichung der Anwendungsrollen, die es auf der Quelle gibt (of_api ab 0009,
-- of_recorder ab 0013), mit deren Attributen und Rolleneinstellungen. pg_dump sichert keine Rollen,
-- nur die GRANTs an sie; ohne diese Datei bräche pg_restore an „role … does not exist" ab.
-- Dazu die Datenbankrechte dieser Rollen und von PUBLIC auf `orderflow` (datacl, z. B. CONNECT aus
-- 0009/0013) – pg_dump ohne --create sichert sie nicht. Rollen gelten clusterweit: eine Rolle kann
-- auf der Quelle existieren, obwohl die Datenbank sie (noch) nicht nutzt; sie wird dann ohne Rechte
-- angelegt, genau wie auf der Quelle.
-- Nie Passwörter (die setzt der Server aus seinen EnvironmentFiles). Bricht ab, wenn eine
-- Anwendungsrolle auf der Quelle erhöhte Rechte hat (dann stimmt etwas nicht).
\set ON_ERROR_STOP on
\set QUIET on
\pset footer off
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname IN ('of_api', 'of_recorder')
               AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN
    RAISE EXCEPTION 'Anwendungsrolle mit erhöhten Rechten auf der Quelle – Transfer abgebrochen';
  END IF;
END
$$;
SELECT s FROM (
  SELECT r.rolname AS n, 0 AS o,
         format('DO $do$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = %L) THEN '
                'CREATE ROLE %I; END IF; END $do$;', r.rolname, r.rolname) AS s
    FROM pg_roles r WHERE r.rolname IN ('of_api', 'of_recorder')
  UNION ALL
  SELECT r.rolname, 1,
         format('ALTER ROLE %I %s NOSUPERUSER NOCREATEDB NOCREATEROLE %s NOREPLICATION NOBYPASSRLS '
                'CONNECTION LIMIT %s;', r.rolname,
                CASE WHEN r.rolcanlogin THEN 'LOGIN' ELSE 'NOLOGIN' END,
                CASE WHEN r.rolinherit THEN 'INHERIT' ELSE 'NOINHERIT' END, r.rolconnlimit)
    FROM pg_roles r WHERE r.rolname IN ('of_api', 'of_recorder')
  UNION ALL
  SELECT r.rolname, 2, format('ALTER ROLE %I RESET ALL;', r.rolname)
    FROM pg_roles r WHERE r.rolname IN ('of_api', 'of_recorder')
  UNION ALL
  SELECT r.rolname, 3, format('ALTER ROLE %I SET %s = %L;', r.rolname, split_part(c, '=', 1),
                              substr(c, strpos(c, '=') + 1))
    FROM pg_roles r, unnest(r.rolconfig) c WHERE r.rolname IN ('of_api', 'of_recorder')
  UNION ALL
  SELECT r.rolname, 4, format('GRANT %s ON DATABASE %I TO %I;',
                              string_agg(a.privilege_type, ', ' ORDER BY a.privilege_type),
                              current_database(), r.rolname)
    FROM pg_database d, aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a
    JOIN pg_roles r ON r.oid = a.grantee
   WHERE d.datname = current_database() AND r.rolname IN ('of_api', 'of_recorder')
   GROUP BY r.rolname
  UNION ALL
  -- PUBLIC wie auf der Quelle (Standard: CONNECT + TEMPORARY; nach harden-db.sql: nichts), damit
  -- datacl| auch bei einer gehärteten Quelle übereinstimmt
  SELECT '', 0, format('REVOKE ALL ON DATABASE %I FROM PUBLIC;', current_database())
  UNION ALL
  SELECT '', 1, format('GRANT %s ON DATABASE %I TO PUBLIC;',
                       string_agg(a.privilege_type, ', ' ORDER BY a.privilege_type), current_database())
    FROM pg_database d, aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a
   WHERE d.datname = current_database() AND a.grantee = 0
  HAVING count(*) > 0
) x ORDER BY n, o, s;
