import { expect, it } from 'vitest';
import { watchCheckFailure } from './watch-runtime.js';

it('carries recipe stop reasons into site backoff instead of treating challenges as ordinary drift', () => {
  expect(watchCheckFailure({ status: 'checkpoint_failed', found: { reason: 'challenge' } })).toEqual({
    status: 'blocked',
  });
  expect(watchCheckFailure({ status: 'checkpoint_failed', found: { reason: 'site_busy' } })).toEqual({
    status: 'site_busy',
  });
  expect(watchCheckFailure({ status: 'checkpoint_failed', observation: { snapshot: 'Verify you are human' } })).toEqual(
    { status: 'blocked' },
  );
  expect(watchCheckFailure({ status: 'checkpoint_failed', found: { heading: 'A changed restaurant title' } })).toEqual({
    status: 'failed',
  });
});
