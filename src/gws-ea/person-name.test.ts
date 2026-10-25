import { describe, expect, it } from 'vitest';

import { displayPersonName, normalizePersonName } from './person-name.js';

describe('structured identity names', () => {
  it('preserves compound boundaries, Unicode, case and internal spaces', () => {
    const name = normalizePersonName({ firstName: '  María  José ', lastName: ' de la Cruz  ' }, 'principal');
    expect(name).toEqual({ firstName: 'María  José', lastName: 'de la Cruz' });
    expect(displayPersonName(name)).toBe('María  José de la Cruz');
  });

  it('normalizes an omitted surname to null without splitting the first name', () => {
    const name = normalizePersonName({ firstName: 'Mary Ann' }, 'assistant');
    expect(name).toEqual({ firstName: 'Mary Ann', lastName: null });
    expect(displayPersonName(name)).toBe('Mary Ann');
  });

  it.each(['name@example.com', '<name>', 'Avery\u2028Wu', 'Avery\u2029Wu'])(
    'refuses invalid first name %j',
    (firstName) => {
      expect(() => normalizePersonName({ firstName, lastName: null }, 'principal')).toThrow();
    },
  );

  it('applies the limit to the combined name and preserves the identity-specific limits', () => {
    expect(() => normalizePersonName({ firstName: 'A'.repeat(40), lastName: 'B'.repeat(40) }, 'principal')).toThrow(
      /80/u,
    );
    expect(displayPersonName(normalizePersonName({ firstName: 'A'.repeat(120) }, 'assistant'))).toHaveLength(120);
    expect(() => normalizePersonName({ firstName: 'A'.repeat(121) }, 'assistant')).toThrow(/120/u);
  });
});
