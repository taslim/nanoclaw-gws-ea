import { expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { observePage, registerPageSecret, releasePageSecret, redactPageText } from './observe.js';

it('redacts registered field values and bearer URLs from every observation', async () => {
  const page = {
    url: () => 'https://example.com/?token=secret-bearer',
    frames: () => [],
    locator: () => ({
      ariaSnapshot: async () =>
        '- textbox "Password": super-secret\n- link "magic": https://example.com/?token=secret-bearer',
    }),
  } as unknown as Page;
  registerPageSecret(page, 'super-secret');
  registerPageSecret(page, 'https://example.com/?token=secret-bearer');
  const observation = await observePage(page);
  expect(JSON.stringify(observation)).not.toContain('super-secret');
  expect(JSON.stringify(observation)).not.toContain('secret-bearer');
  expect(redactPageText(page, 'super-secret')).toBe('[redacted]');
  releasePageSecret(page, 'super-secret');
  expect(redactPageText(page, 'super-secret')).toBe('[redacted]');
});
