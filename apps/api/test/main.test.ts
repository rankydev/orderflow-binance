import { afterEach, describe, expect, it, vi } from 'vitest';
import { APP_NAME, main, PLANNED_PHASE } from '../src/main.ts';

describe('api Platzhalter', () => {
  afterEach(() => vi.restoreAllMocks());

  it('meldet "nicht implementiert" mit Exit-Code 2', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(main()).toBe(2);
    expect(err).toHaveBeenCalledWith(expect.stringContaining(APP_NAME));
    expect(PLANNED_PHASE).toMatch(/^P\d$/);
  });
});
