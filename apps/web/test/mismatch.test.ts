// W-1: Wiederherstellung nach Konfigurationswechsel.
import { describe, expect, it } from 'vitest';
import {
  MIN_REFETCH_MS,
  MismatchRecovery,
  RETRY_MS,
  tileConfigChanged,
} from '../src/lib/mismatch.ts';

describe('MismatchRecovery', () => {
  it('mehrere 409 vor der /symbols-Antwort → nur ein Neuladen, danach Footprint aktiv', () => {
    const m = new MismatchRecovery();
    expect(m.onMismatch(2, 2, 0)).toBe('refetch');
    expect(m.onMismatch(2, 2, 1)).toBe('ignore'); // zweite Antwort derselben Welle
    expect(m.onMismatch(2, 2, 2)).toBe('ignore');
    m.onRefetched(true, 10); // neue Konfiguration 3
    expect(m.blocked).toBe(false);
    expect(m.state).toBe('idle');
  });

  it('späte Antworten der alten Konfiguration nach dem Wechsel zählen nicht', () => {
    const m = new MismatchRecovery();
    m.onMismatch(2, 2, 0);
    m.onRefetched(true, 10);
    expect(m.onMismatch(2, 3, 11)).toBe('ignore');
    expect(m.blocked).toBe(false);
  });

  it('Neuladen ohne Änderung → gesperrt; nach RETRY_MS neuer Versuch, der entsperren kann', () => {
    const m = new MismatchRecovery();
    m.onMismatch(3, 3, 0);
    m.onRefetched(false, 10);
    expect(m.blocked).toBe(true);
    expect(m.onMismatch(3, 3, 10 + RETRY_MS - 1)).toBe('ignore');
    expect(m.onMismatch(3, 3, 10 + RETRY_MS)).toBe('refetch');
    m.onRefetched(true, 10 + RETRY_MS + 5);
    expect(m.blocked).toBe(false);
  });

  it('Abweichung NACH erfolgreichem Wechsel löst wieder ein Neuladen aus – frühestens nach 30 s', () => {
    const m = new MismatchRecovery();
    m.onMismatch(1, 1, 0);
    m.onRefetched(true, 5);
    expect(m.onMismatch(2, 2, 6)).toBe('ignore'); // c: Mindestabstand
    expect(m.onMismatch(2, 2, MIN_REFETCH_MS)).toBe('refetch');
    m.onRefetched(false, MIN_REFETCH_MS + 1);
    expect(m.blocked).toBe(true);
  });

  it('a: Sperre läuft nach RETRY_MS ab (Timer im Controller), auch ohne neue Abweichung', () => {
    const m = new MismatchRecovery();
    m.onMismatch(1, 1, 0);
    m.onRefetched(false, 100);
    expect(m.expire(100 + RETRY_MS - 1)).toBe(false);
    expect(m.blocked).toBe(true);
    expect(m.expire(100 + RETRY_MS)).toBe(true);
    expect(m.blocked).toBe(false);
    expect(m.onMismatch(1, 1, 100 + RETRY_MS + 1)).toBe('refetch');
  });

  it('c: „geändert" nur bei Kachelkonfiguration, nicht bei dataTo oder Schlüsselreihenfolge', () => {
    const a = { tileConfigVersion: 3, tiles: { '1m': { '10': 32, '20': 64 } }, dataTo: 1 };
    expect(tileConfigChanged(a, { ...a, tiles: { '1m': { '20': 64, '10': 32 } } })).toBe(false);
    expect(tileConfigChanged(a, { ...a, tileConfigVersion: 4 })).toBe(true);
    expect(tileConfigChanged(a, { ...a, tiles: { '1m': { '10': 64, '20': 64 } } })).toBe(true);
    expect(tileConfigChanged(a, undefined)).toBe(true);
    const b = { ...a, dataTo: 999 };
    expect(tileConfigChanged(a, b)).toBe(false);
  });
});
