import { expect, it } from 'vitest';
import { validateBrowserBatch } from './executor.js';

it('rejects unknown actions and clipboard shortcuts without running a partial batch', () => {
  expect(() =>
    validateBrowserBatch({ actions: [{ kind: 'observe' }, { kind: 'evaluate', expression: 'alert(1)' }] }),
  ).toThrow();
  for (const key of ['Control+Shift+V', 'Meta+Shift+V', 'Meta+C', 'Control+X', 'Shift+Insert'])
    expect(() => validateBrowserBatch({ actions: [{ kind: 'key', ref: 'e1', generation: 1, key }] })).toThrow();
  expect(() => validateBrowserBatch({ actions: [{ kind: 'key', ref: 'e1', generation: 1, key: 'Meta+V' }] })).toThrow();
  expect(() =>
    validateBrowserBatch({ actions: [{ kind: 'type', ref: 'e1', generation: 1, text: 'hello', selector: 'body' }] }),
  ).toThrow();
  expect(
    validateBrowserBatch({ actions: [{ kind: 'navigate', url: 'https://example.com/' }, { kind: 'observe' }] }),
  ).toEqual({ actions: [{ kind: 'navigate', url: 'https://example.com/' }, { kind: 'observe' }] });
});
