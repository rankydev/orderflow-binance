-- Bestehende Tage, deren Übertrag aus dem gespeicherten bzw. im selben Lauf berechneten Vortag
-- stammt, haben genau dessen cand(1439) verwendet: nachtragen, damit sie nicht allein wegen der
-- neuen Spalte neu geschrieben werden. Tage mit Nachbar-/Schätz-Übertrag bleiben NULL (unbekannt).
UPDATE data_day d
   SET cand_in_q = p.cand_last_q, cand_in_b = p.cand_last_b
  FROM data_day p
 WHERE p.sym_id = d.sym_id AND p.day = d.day - 1
   AND d.carry_in_origin IN ('chain', 'stored')
   AND p.carry_q = d.carry_in_q AND p.carry_b = d.carry_in_b;
