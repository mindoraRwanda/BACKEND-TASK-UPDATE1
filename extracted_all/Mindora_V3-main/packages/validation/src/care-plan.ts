import { z } from 'zod';

const carePlanMilestoneSchema = z.object({
  title: z.string().trim().min(1).max(160),
  dueDate: z.string().datetime().optional(),
});

export const carePlanContentSchema = z.object({
  title: z.string().trim().min(1).max(120),
  goals: z.array(z.string().trim().min(1).max(300)).min(1).max(20),
  milestones: z.array(carePlanMilestoneSchema).max(30).default([]),
  reviewDate: z.string().datetime().optional(),
});

export const createCarePlanSchema = carePlanContentSchema.extend({
  patientId: z.string().uuid(),
});

export const updateCarePlanSchema = carePlanContentSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one care plan field must be supplied',
  });

export type CreateCarePlanDto = z.infer<typeof createCarePlanSchema>;
export type UpdateCarePlanDto = z.infer<typeof updateCarePlanSchema>;
