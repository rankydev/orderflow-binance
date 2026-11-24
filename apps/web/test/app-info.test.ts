import { describe, expect, it } from 'vitest';
import { APP_TITLE, CHARTS_ATTRIBUTION, CHARTS_URL } from '../src/app-info.ts';

describe('app-info', () => {
  it('führt die Pflicht-Attribution für lightweight-charts', () => {
    expect(APP_TITLE).toBe('orderflow-binance');
    expect(CHARTS_ATTRIBUTION).toContain('TradingView');
    expect(CHARTS_URL).toMatch(/^https:\/\//);
  });
});
