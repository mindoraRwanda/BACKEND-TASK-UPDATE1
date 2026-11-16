import { describe, expect, it } from 'vitest';
import { updateAvailabilitySchema } from './appointment.js';

describe('updateAvailabilitySchema timezone', () => {
  const workingHours = [{ dayOfWeek: 1, startMinute: 540, endMinute: 1020 }];

  it('accepts Africa/Kigali and defaults an omitted timezone to Africa/Kigali', () => {
    expect(
      updateAvailabilitySchema.parse({
        timezone: 'Africa/Kigali',
        workingHours,
      })
    ).toEqual({ timezone: 'Africa/Kigali', workingHours });
    expect(updateAvailabilitySchema.parse({ workingHours }).timezone).toBe(
      'Africa/Kigali'
    );
  });

  it('rejects unsupported timezones', () => {
    expect(
      updateAvailabilitySchema.safeParse({
        timezone: 'America/New_York',
        workingHours,
      }).success
    ).toBe(false);
  });
});
