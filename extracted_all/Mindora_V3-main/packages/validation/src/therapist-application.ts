import { z } from 'zod';

export const therapistApplicationStatusSchema = z.enum([
  'DRAFT',
  'SUBMITTED',
  'UNDER_REVIEW',
  'APPROVED',
  'REJECTED',
  'MORE_INFORMATION_REQUIRED',
]);

const applicantPhoneNumber = z
  .string()
  .trim()
  .min(7, 'Phone number is too short')
  .max(20, 'Phone number is too long');

const applicantContactEmail = z
  .string()
  .trim()
  .toLowerCase()
  .email('Invalid email address');

export const uploadDocumentTypeSchema = z.enum([
  'CV',
  'LICENSE',
  'DIPLOMA',
  'CERTIFICATION',
  'ID',
  'OTHER',
]);

// All fields optional — this backs incremental autosave of a DRAFT or a
// MORE_INFORMATION_REQUIRED application. Full-record validation happens
// separately, in submitTherapistApplicationSchema, at the submit step.
export const updateTherapistApplicationSchema = z.object({
  fullName: z.string().trim().min(2).max(100).optional(),
  phoneNumber: applicantPhoneNumber.optional(),
  contactEmail: applicantContactEmail.optional(),
  professionalBio: z.string().trim().min(1).max(4000).optional(),
  qualifications: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  certifications: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  licenseNumber: z.string().trim().min(1).max(100).optional(),
  licenseIssuingBody: z.string().trim().min(1).max(200).optional(),
  // .nullish() (not .optional()) — a PUT may explicitly send null to clear
  // one of these, and the corresponding Prisma columns are nullable.
  licenseExpiryDate: z.coerce.date().nullish(),
  professionalRegistrationNumber: z.string().trim().max(100).nullish(),
  specialisations: z
    .array(z.string().trim().min(1).max(100))
    .min(1)
    .max(10)
    .optional(),
  yearsOfExperience: z.coerce.number().int().min(0).max(70).optional(),
  languages: z
    .array(z.string().trim().min(1).max(50))
    .min(1)
    .max(10)
    .optional(),
  availabilitySummary: z.string().trim().max(1000).nullish(),
  location: z.string().trim().min(1).max(200).optional(),
  timezone: z.string().trim().min(1).max(64).optional(),
});

// Every field the review workflow depends on must be present before a
// DRAFT/MORE_INFORMATION_REQUIRED application can transition to SUBMITTED,
// even though saving a draft (above) is all-optional.
export const submitTherapistApplicationSchema = z.object({
  fullName: z.string().trim().min(2).max(100),
  phoneNumber: applicantPhoneNumber,
  contactEmail: applicantContactEmail,
  professionalBio: z.string().trim().min(1).max(4000),
  qualifications: z.array(z.string().trim().min(1).max(200)).min(1).max(20),
  certifications: z
    .array(z.string().trim().min(1).max(200))
    .max(20)
    .default([]),
  licenseNumber: z.string().trim().min(1).max(100),
  licenseIssuingBody: z.string().trim().min(1).max(200),
  // .nullish() — these are optional fields backed by nullable Prisma
  // columns, so a never-filled-in application has them as null (Prisma's
  // representation of "unset"), not undefined. Discovered live: submitting
  // a fully-valid application still 400'd until this matched Prisma's
  // actual null, not just JS's undefined.
  licenseExpiryDate: z.coerce.date().nullish(),
  professionalRegistrationNumber: z.string().trim().max(100).nullish(),
  specialisations: z.array(z.string().trim().min(1).max(100)).min(1).max(10),
  yearsOfExperience: z.coerce.number().int().min(0).max(70),
  languages: z.array(z.string().trim().min(1).max(50)).min(1).max(10),
  availabilitySummary: z.string().trim().max(1000).nullish(),
  location: z.string().trim().min(1).max(200),
  timezone: z.string().trim().min(1).max(64).default('Africa/Kigali'),
});

export const listTherapistApplicationsQuerySchema = z.object({
  status: therapistApplicationStatusSchema.optional(),
  search: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  sortBy: z
    .enum(['submittedAt', 'createdAt', 'reviewedAt', 'fullName'])
    .default('submittedAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

// Public admin-service route bodies — reviewedBy is never client-supplied
// here, admin-service derives it from the caller's own JWT and forwards it
// separately to the internal endpoint below.
export const adminRejectApplicationSchema = z.object({
  reason: z.string().trim().min(1).max(1000),
});

export const adminRequestInfoApplicationSchema = z.object({
  note: z.string().trim().min(1).max(1000),
});

// Internal (SERVICE-role) endpoint body — called by admin-service, which
// supplies reviewedBy itself since the internal call carries no user JWT.
export const internalUpdateApplicationStatusSchema = z.object({
  status: therapistApplicationStatusSchema,
  reviewedBy: z.string().uuid(),
  reason: z.string().trim().min(1).max(1000).optional(),
  note: z.string().trim().min(1).max(1000).optional(),
});

export const addApplicationNoteSchema = z.object({
  authorId: z.string().uuid(),
  note: z.string().trim().min(1).max(2000),
});

// admin-service's own public route body — authorId is never client-supplied
// here, admin-service derives it from the caller's JWT and forwards the
// full addApplicationNoteSchema shape to the internal endpoint above.
export const adminAddApplicationNoteSchema = z.object({
  note: z.string().trim().min(1).max(2000),
});

export const therapistSuspensionSchema = z.object({
  isSuspended: z.boolean(),
});

export type TherapistApplicationStatusDto = z.infer<
  typeof therapistApplicationStatusSchema
>;
export type UploadDocumentTypeDto = z.infer<typeof uploadDocumentTypeSchema>;
export type UpdateTherapistApplicationDto = z.infer<
  typeof updateTherapistApplicationSchema
>;
export type SubmitTherapistApplicationDto = z.infer<
  typeof submitTherapistApplicationSchema
>;
export type ListTherapistApplicationsQueryDto = z.infer<
  typeof listTherapistApplicationsQuerySchema
>;
export type AdminRejectApplicationDto = z.infer<
  typeof adminRejectApplicationSchema
>;
export type AdminRequestInfoApplicationDto = z.infer<
  typeof adminRequestInfoApplicationSchema
>;
export type InternalUpdateApplicationStatusDto = z.infer<
  typeof internalUpdateApplicationStatusSchema
>;
export type AddApplicationNoteDto = z.infer<typeof addApplicationNoteSchema>;
export type TherapistSuspensionDto = z.infer<typeof therapistSuspensionSchema>;
