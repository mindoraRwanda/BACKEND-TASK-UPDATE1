import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  publish: vi.fn(),
}));

vi.mock('./prisma.js', () => ({
  prisma: { $transaction: (...args: unknown[]) => mocks.transaction(...args) },
}));

vi.mock('./publish-appointment-event.js', () => ({
  publishAppointmentEvent: (...args: unknown[]) => mocks.publish(...args),
}));

import {
  bookAppointmentWithLock,
  PastAppointmentError,
  SlotUnavailableError,
} from './book-appointment.js';

const therapistId = '22222222-2222-4222-8222-222222222222';
const patientId = '11111111-1111-4111-8111-111111111111';

function upcomingInput() {
  const localDate = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000 + 2 * 60 * 60 * 1000);
  const slotStart = new Date(
    Date.UTC(
      localDate.getUTCFullYear(),
      localDate.getUTCMonth(),
      localDate.getUTCDate(),
      8
    )
  );
  return {
    therapistId,
    slotStart,
    slotEnd: new Date(slotStart.getTime() + 60 * 60 * 1000),
    sessionType: 'VIDEO' as const,
    dayOfWeek: localDate.getUTCDay(),
  };
}

function setup(schedule: unknown) {
  const appointment = {
    id: '33333333-3333-4333-8333-333333333333',
    patientId,
    therapistId,
    slotStart: input.slotStart,
    slotEnd: input.slotEnd,
    sessionType: 'VIDEO',
  };
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(undefined),
    $queryRaw: vi.fn().mockResolvedValue([]),
    therapistSchedule: {
      findUnique: vi.fn().mockResolvedValue(schedule),
    },
    appointment: {
      create: vi.fn().mockResolvedValue(appointment),
    },
  };

  mocks.transaction.mockImplementation(async (callback) => callback(tx));
  mocks.publish.mockResolvedValue(undefined);
  return tx;
}

let input: ReturnType<typeof upcomingInput>;

describe('bookAppointmentWithLock availability checks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    input = upcomingInput();
  });

  it('keeps the advisory lock, schedule checks, conflict query, and insert in the transaction', async () => {
    const tx = setup({
      workingHours: [
        { dayOfWeek: input.dayOfWeek, startMinute: 540, endMinute: 1020 },
      ],
      timeOff: [],
    });

    await bookAppointmentWithLock(patientId, input);

    expect(tx.$executeRaw).toHaveBeenCalledOnce();
    expect(tx.therapistSchedule.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { therapistId },
        include: expect.objectContaining({ workingHours: true }),
      })
    );
    expect(tx.$queryRaw).toHaveBeenCalledOnce();
    expect(tx.appointment.create).toHaveBeenCalledOnce();
    expect(mocks.publish).toHaveBeenCalledOnce();
  });

  it('rejects past appointments before querying availability or inserting', async () => {
    input.slotStart = new Date(Date.now() - 60_000);
    input.slotEnd = new Date(input.slotStart.getTime() + 60 * 60 * 1000);
    const tx = setup(null);

    await expect(bookAppointmentWithLock(patientId, input)).rejects.toBeInstanceOf(
      PastAppointmentError
    );
    expect(tx.therapistSchedule.findUnique).not.toHaveBeenCalled();
    expect(tx.appointment.create).not.toHaveBeenCalled();
  });

  it.each([null, { workingHours: [], timeOff: [] }])(
    'rejects a missing or empty schedule',
    async (schedule) => {
      const tx = setup(schedule);

      await expect(
        bookAppointmentWithLock(patientId, input)
      ).rejects.toBeInstanceOf(SlotUnavailableError);
      expect(tx.appointment.create).not.toHaveBeenCalled();
    }
  );

  it('rejects an appointment outside configured working hours', async () => {
    const tx = setup({
      workingHours: [
        { dayOfWeek: input.dayOfWeek, startMinute: 660, endMinute: 1020 },
      ],
      timeOff: [],
    });

    await expect(
      bookAppointmentWithLock(patientId, input)
    ).rejects.toBeInstanceOf(SlotUnavailableError);
    expect(tx.appointment.create).not.toHaveBeenCalled();
  });

  it('rejects an appointment overlapping therapist time off', async () => {
    const tx = setup({
      workingHours: [
        { dayOfWeek: input.dayOfWeek, startMinute: 540, endMinute: 1020 },
      ],
      timeOff: [{ startsAt: input.slotStart, endsAt: input.slotEnd }],
    });

    await expect(
      bookAppointmentWithLock(patientId, input)
    ).rejects.toBeInstanceOf(SlotUnavailableError);
    expect(tx.appointment.create).not.toHaveBeenCalled();
  });
});
