import { describe, expect, it } from 'vitest';
import { generateCandidateSlotsFromWorkingHours } from './availability.js';

describe('generateCandidateSlotsFromWorkingHours', () => {
  // Africa/Kigali is UTC+2, so 09:00-17:00 Kigali local is 07:00-15:00 UTC.
  const mondayNineToFive = [
    { dayOfWeek: 1, startMinute: 540, endMinute: 1020 },
  ];

  it('only produces slots inside the configured Kigali-local window', () => {
    // 2026-06-08 is a Monday.
    const from = new Date('2026-06-08T00:00:00.000Z');
    const to = new Date('2026-06-09T00:00:00.000Z');

    const slots = generateCandidateSlotsFromWorkingHours(
      from,
      to,
      mondayNineToFive
    );

    expect(slots).toHaveLength(8); // 07:00..14:00 UTC start hours = 8 one-hour slots
    expect(slots[0].slotStart.toISOString()).toBe('2026-06-08T07:00:00.000Z');
    expect(slots.at(-1)!.slotStart.toISOString()).toBe(
      '2026-06-08T14:00:00.000Z'
    );
    expect(slots.at(-1)!.slotEnd.toISOString()).toBe(
      '2026-06-08T15:00:00.000Z'
    );
  });

  it('produces no slots on a day with no configured window', () => {
    // 2026-06-09 is a Tuesday — only Monday is configured above.
    const from = new Date('2026-06-09T00:00:00.000Z');
    const to = new Date('2026-06-10T00:00:00.000Z');

    const slots = generateCandidateSlotsFromWorkingHours(
      from,
      to,
      mondayNineToFive
    );

    expect(slots).toHaveLength(0);
  });

  it('supports multiple windows on the same day (e.g. a lunch-break split)', () => {
    // Monday 07:00-09:00 UTC and 11:00-13:00 UTC (09:00-11:00 and
    // 13:00-15:00 Kigali local), skipping the 09:00-11:00 UTC lunch window.
    const split = [
      { dayOfWeek: 1, startMinute: 540, endMinute: 660 }, // 09:00-11:00 Kigali
      { dayOfWeek: 1, startMinute: 780, endMinute: 900 }, // 13:00-15:00 Kigali
    ];
    const from = new Date('2026-06-08T00:00:00.000Z');
    const to = new Date('2026-06-09T00:00:00.000Z');

    const slots = generateCandidateSlotsFromWorkingHours(from, to, split);
    const starts = slots.map((s) => s.slotStart.toISOString());

    expect(starts).toEqual([
      '2026-06-08T07:00:00.000Z',
      '2026-06-08T08:00:00.000Z',
      '2026-06-08T11:00:00.000Z',
      '2026-06-08T12:00:00.000Z',
    ]);
  });

  it('respects the from/to range boundaries', () => {
    const from = new Date('2026-06-08T08:30:00.000Z');
    const to = new Date('2026-06-08T09:30:00.000Z');

    const slots = generateCandidateSlotsFromWorkingHours(
      from,
      to,
      mondayNineToFive
    );

    // Only a slot fully contained within [from, to) can start on the hour
    // at or after 08:30 and end by 09:30 — none does, since hourly slots
    // start on the hour.
    expect(slots).toHaveLength(0);
  });
});
