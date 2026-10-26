import { vi } from 'vitest';
import * as availability from '../availability.js';

const inspectAvailability = availability.browserAvailability;

/** Exercise real path admission with this process as the executable dependency in tests without native Chrome. */
export function useAvailableBrowser(): void {
  vi.spyOn(availability, 'browserAvailability').mockImplementation((root, chromePath = process.execPath) =>
    inspectAvailability(root, chromePath),
  );
}
