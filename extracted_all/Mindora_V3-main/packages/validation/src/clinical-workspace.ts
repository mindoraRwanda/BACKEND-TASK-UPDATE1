import { z } from 'zod';

const prescriptionDraftFields = {
  medicationName: z.string().trim().min(1).max(160),
  strength: z.string().trim().max(120).default(''),
  frequency: z.string().trim().max(160).default(''),
  instructions: z.string().trim().max(2000).default(''),
};

export const createPrescriptionDraftSchema = z.object({
  patientId: z.string().uuid(),
  ...prescriptionDraftFields,
});

export const updatePrescriptionDraftSchema = z
  .object({
    medicationName: prescriptionDraftFields.medicationName.optional(),
    strength: z.string().trim().max(120).optional(),
    frequency: z.string().trim().max(160).optional(),
    instructions: z.string().trim().max(2000).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one prescription draft field must be supplied',
  });

export const createMedicationUpdateSchema = z.object({
  therapistId: z.string().uuid(),
  medicationName: z.string().trim().min(1).max(160),
  updateType: z.enum([
    'STARTED',
    'STOPPED',
    'CHANGED',
    'SIDE_EFFECT',
    'QUESTION',
  ]),
  note: z.string().trim().max(2000).default(''),
});

export const reviewMedicationUpdateSchema = z.object({
  status: z.enum(['REVIEWED', 'FOLLOW_UP_REQUIRED']),
  reviewNote: z.string().trim().max(2000).default(''),
});

export type CreatePrescriptionDraftDto = z.infer<
  typeof createPrescriptionDraftSchema
>;
export type UpdatePrescriptionDraftDto = z.infer<
  typeof updatePrescriptionDraftSchema
>;
export type CreateMedicationUpdateDto = z.infer<
  typeof createMedicationUpdateSchema
>;
export type ReviewMedicationUpdateDto = z.infer<
  typeof reviewMedicationUpdateSchema
>;
