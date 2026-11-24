-- Absichtlich leer: Die Erweiterung ist Infrastruktur und wird nicht per Rollback entfernt
-- (DROP EXTENSION timescaledb muss erster Befehl einer frischen Sitzung sein und würde alles
-- mitreißen). Vollständiges Zurücksetzen: `npm run db:reset` bzw. `npm run db:destroy`.
SELECT 1;
