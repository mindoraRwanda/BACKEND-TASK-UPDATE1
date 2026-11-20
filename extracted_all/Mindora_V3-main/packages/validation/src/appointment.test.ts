import { describe, expect, it } from 'vitest';
import { bookAppointmentSchema } from './appointment.js';

describe('bookAppointmentSchema session types', () => {
  const base = {
    therapistId: '7c3d6f28-2b6a-4b4f-8a5e-8a4c7d3e9a11',
    slotStart: '2026-11-25T09:00:00.000Z',
    slotEnd: '2026-11-25T10:00:00.000Z',
  };

  it.each(['VIDEO', 'AUDIO'] as const)(
    'accepts current product session type %s',
    (sessionType) => {
      expect(
        bookAppointmentSchema.safeParse({ ...base, sessionType }).success
      ).toBe(true);
    }
  );

  it.each(['IN_PERSON', 'CHAT', 'PHONE'] as const)(
    'rejects unsupported new booking type %s while preserving legacy database values',
    (sessionType) => {
      expect(
        bookAppointmentSchema.safeParse({ ...base, sessionType }).success
      ).toBe(false);
    }
  );
});
