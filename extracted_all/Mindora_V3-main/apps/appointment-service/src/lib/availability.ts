const BUSINESS_HOUR_START = 9;
const BUSINESS_HOUR_END = 17;
const SLOT_DURATION_MS = 60 * 60 * 1000;

export interface TimeSlot {
  slotStart: Date;
  slotEnd: Date;
}

function overlaps(
  slotStart: Date,
  slotEnd: Date,
  blockedStart: Date,
  blockedEnd: Date
): boolean {
  return slotStart < blockedEnd && slotEnd > blockedStart;
}

export function generateCandidateSlots(from: Date, to: Date): TimeSlot[] {
  const slots: TimeSlot[] = [];
  const cursor = new Date(from);
  cursor.setUTCMinutes(0, 0, 0);

  if (cursor < from) {
    cursor.setUTCHours(cursor.getUTCHours() + 1);
  }

  while (cursor < to) {
    const hour = cursor.getUTCHours();
    if (hour >= BUSINESS_HOUR_START && hour < BUSINESS_HOUR_END) {
      const slotEnd = new Date(cursor.getTime() + SLOT_DURATION_MS);
      if (slotEnd <= to && cursor >= from) {
        slots.push({ slotStart: new Date(cursor), slotEnd });
      }
    }
    cursor.setUTCHours(cursor.getUTCHours() + 1);
  }

  return slots;
}

export function filterAvailableSlots(
  candidates: TimeSlot[],
  blocked: TimeSlot[]
): TimeSlot[] {
  return candidates.filter(
    (candidate) =>
      !blocked.some((booked) =>
        overlaps(
          candidate.slotStart,
          candidate.slotEnd,
          booked.slotStart,
          booked.slotEnd
        )
      )
  );
}

export function defaultAvailabilityRange(): { from: Date; to: Date } {
  const from = new Date();
  const to = new Date(from.getTime() + 7 * 24 * 60 * 60 * 1000);
  return { from, to };
}

// Africa/Kigali is fixed UTC+2 with no DST, so "local day-of-week and
// minute-of-day" is just a +2h shift read back out in UTC fields — no
// timezone library needed, and no ambiguity around DST transitions this
// platform's target market doesn't have.
const KIGALI_OFFSET_MINUTES = 120;

export interface WorkingHoursWindow {
  dayOfWeek: number; // 0=Sunday..6=Saturday
  startMinute: number;
  endMinute: number;
}

function toKigaliParts(date: Date): { dayOfWeek: number; minuteOfDay: number } {
  const shifted = new Date(date.getTime() + KIGALI_OFFSET_MINUTES * 60 * 1000);
  return {
    dayOfWeek: shifted.getUTCDay(),
    minuteOfDay: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

// Same hourly-slot cadence as generateCandidateSlots above, but windowed by
// the therapist's own configured working hours instead of a fixed 9-5.
// Used when a TherapistSchedule with at least one working-hours row exists;
// callers fall back to generateCandidateSlots otherwise (see
// appointment.routes.ts) so an approved therapist who hasn't configured
// availability yet isn't simply unbookable.
export function generateCandidateSlotsFromWorkingHours(
  from: Date,
  to: Date,
  workingHours: WorkingHoursWindow[]
): TimeSlot[] {
  const byDay = new Map<number, WorkingHoursWindow[]>();
  for (const window of workingHours) {
    const existing = byDay.get(window.dayOfWeek);
    if (existing) existing.push(window);
    else byDay.set(window.dayOfWeek, [window]);
  }

  const slots: TimeSlot[] = [];
  const cursor = new Date(from);
  cursor.setUTCMinutes(0, 0, 0);
  if (cursor < from) {
    cursor.setUTCHours(cursor.getUTCHours() + 1);
  }

  while (cursor < to) {
    const { dayOfWeek, minuteOfDay } = toKigaliParts(cursor);
    const windows = byDay.get(dayOfWeek) ?? [];
    const slotEndMinute = minuteOfDay + SLOT_DURATION_MS / 60_000;
    const inWindow = windows.some(
      (w) => minuteOfDay >= w.startMinute && slotEndMinute <= w.endMinute
    );
    if (inWindow) {
      const slotEnd = new Date(cursor.getTime() + SLOT_DURATION_MS);
      if (slotEnd <= to && cursor >= from) {
        slots.push({ slotStart: new Date(cursor), slotEnd });
      }
    }
    cursor.setUTCHours(cursor.getUTCHours() + 1);
  }

  return slots;
}
