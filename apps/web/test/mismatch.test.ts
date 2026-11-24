// W-1: Wiederherstellung nach Konfigurationswechsel.
import { describe, expect, it } from 'vitest';
import { MismatchRecovery, RETRY_MS } from '../src/lib/mismatch.ts';

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

  it('Abweichung NACH erfolgreichem Wechsel löst wieder ein Neuladen aus (nicht sofort Sperre)', () => {
    const m = new MismatchRecovery();
    m.onMismatch(1, 1, 0);
    m.onRefetched(true, 5);
    expect(m.onMismatch(2, 2, 6)).toBe('refetch');
    m.onRefetched(false, 7);
    expect(m.blocked).toBe(true);
  });
});
