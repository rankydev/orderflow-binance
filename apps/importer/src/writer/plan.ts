// --plan: liest den gespeicherten Zustand über einen echten Schreiber (nur lesend geöffnet) und
// zeichnet auf, was ein Lauf schreiben, überspringen, kaskadieren oder als veraltet markieren
// würde – ohne irgendetwas zu verändern.
import { formatDay } from '@orderflow/core';
import type { DayWrite, DayWriter, EdgeUpdate, StoredDay, WriteOutcome } from './types.ts';
import { stateOf } from './types.ts';

export class PlanWriter implements DayWriter {
  readonly kind;
  readonly actions: string[] = [];
  private readonly inner: DayWriter;

  constructor(inner: DayWriter) {
    this.inner = inner;
    this.kind = inner.kind;
  }

  open(): Promise<void> {
    return this.inner.open();
  }
  bigFloorN(): number | null {
    return this.inner.bigFloorN();
  }
  close(): Promise<void> {
    return this.inner.close();
  }
  storedDay(symbol: string, day: number): Promise<StoredDay | null> {
    return this.inner.storedDay(symbol, day);
  }
  async touchDay(day: number): Promise<void> {
    this.actions.push(`${formatDay(day)} Herkunft aktualisieren (Daten unverändert)`);
  }
  async markStale(day: number, reason: string): Promise<void> {
    this.actions.push(`${formatDay(day)} als stale markieren (${reason})`);
  }
  async writeDay(w: DayWrite): Promise<WriteOutcome> {
    this.actions.push(`${w.data.dayStr} schreiben`);
    return { dbDigest: null, state: stateOf(w.recon, w.extraBad), version: null };
  }
  async resolveEdge(e: EdgeUpdate): Promise<boolean> {
    this.actions.push(`${formatDay(e.day)} Randminute ${e.minute} entscheiden (falls offen)`);
    return false;
  }
}
