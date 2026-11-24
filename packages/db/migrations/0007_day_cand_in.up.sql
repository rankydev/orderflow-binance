-- Review H-a: cand(1439) des Vortags ist die untere Hüllgrenze für Minute 0 und damit eine
-- Eingabe der Klassifikation; ändert sie sich bei einem Re-Import des Vortags, muss der Tag neu
-- klassifiziert werden. Wie carry_in_* gespeichert und verglichen.
ALTER TABLE data_day
  ADD COLUMN cand_in_q bigint,
  ADD COLUMN cand_in_b bigint;
