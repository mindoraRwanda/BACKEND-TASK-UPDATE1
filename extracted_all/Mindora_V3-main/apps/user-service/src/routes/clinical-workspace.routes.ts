import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { Router } from 'express';
import {
  createMedicationUpdateSchema,
  createPrescriptionDraftSchema,
  reviewMedicationUpdateSchema,
  updatePrescriptionDraftSchema,
} from '@mindora/validation';
import { httpClient } from '@mindora/http-client';
import {
  verifyJwt,
  type AuthenticatedRequest,
} from '../middleware/authenticate.js';
import { authenticatedRouteLimiter } from '../middleware/rate-limit.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { prisma } from '../lib/prisma.js';
import type { Prisma } from '../generated/prisma/index.js';

export const clinicalWorkspaceRouter = Router();

const KONG_URL = process.env.KONG_URL ?? 'http://localhost:8000';
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type PrescriptionDraftPayload = {
  medicationName: string;
  strength: string;
  frequency: string;
  instructions: string;
};

type MedicationUpdatePayload = {
  medicationName: string;
  updateType: 'STARTED' | 'STOPPED' | 'CHANGED' | 'SIDE_EFFECT' | 'QUESTION';
  note: string;
  reviewNote?: string;
};

type PrescriptionDraftRecord = {
  id: string;
  therapistId: string;
  patientId: string;
  encryptedPayload: string;
  status: 'DRAFT' | 'ARCHIVED';
  createdAt: Date;
  updatedAt: Date;
};

type MedicationUpdateRecord = {
  id: string;
  therapistId: string;
  patientId: string;
  encryptedPayload: string;
  status: 'PENDING' | 'REVIEWED' | 'FOLLOW_UP_REQUIRED';
  reviewedAt: Date | null;
  reviewedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type MedicationReviewStatus = 'REVIEWED' | 'FOLLOW_UP_REQUIRED';

function clinicalEncryptionKey(purpose: string): Buffer {
  const rootKey = process.env.THERAPIST_CARE_PLAN_ENCRYPTION_KEY;
  if (!rootKey || rootKey.trim().length < 32) {
    throw new Error('Clinical workspace encryption is not configured');
  }

  // Domain separation: prescription drafts and medication updates never reuse
  // the same derived AES key, even though they inherit the configured master key.
  return createHash('sha256')
    .update(rootKey, 'utf8')
    .update(':mindora-clinical-workspace:')
    .update(purpose, 'utf8')
    .digest();
}

function encryptClinicalPayload(payload: unknown, purpose: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    'aes-256-gcm',
    clinicalEncryptionKey(purpose),
    iv
  );
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]);

  return [
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

function decryptClinicalPayload<T>(encoded: string, purpose: string): T {
  const [ivB64, tagB64, ciphertextB64] = encoded.split(':');
  if (!ivB64 || !tagB64 || !ciphertextB64) {
    throw new Error('Invalid encrypted clinical workspace payload');
  }

  const decipher = createDecipheriv(
    'aes-256-gcm',
    clinicalEncryptionKey(purpose),
    Buffer.from(ivB64, 'base64')
  );
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');

  return JSON.parse(plaintext) as T;
}

async function verifyTherapistPatientRelationship(
  therapistId: string,
  patientId: string
): Promise<boolean | null> {
  try {
    const response = await httpClient.get<{ hasRelationship: boolean }>(
      KONG_URL,
      `/internal/appointments/relationship/${encodeURIComponent(therapistId)}/${encodeURIComponent(patientId)}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.INTERNAL_SERVICE_TOKEN}`,
        },
      }
    );

    if (!response.ok || !response.data) return null;
    return response.data.hasRelationship === true;
  } catch {
    return null;
  }
}

function requireRole(
  authReq: AuthenticatedRequest,
  role: 'PATIENT' | 'THERAPIST'
): boolean {
  return authReq.user?.role === role;
}

function publicPrescriptionDraft(record: PrescriptionDraftRecord) {
  return {
    id: record.id,
    therapistId: record.therapistId,
    patientId: record.patientId,
    ...decryptClinicalPayload<PrescriptionDraftPayload>(
      record.encryptedPayload,
      'prescription-draft-v1'
    ),
    status: record.status,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function publicMedicationUpdate(record: MedicationUpdateRecord) {
  return {
    id: record.id,
    therapistId: record.therapistId,
    patientId: record.patientId,
    ...decryptClinicalPayload<MedicationUpdatePayload>(
      record.encryptedPayload,
      'medication-update-v1'
    ),
    status: record.status,
    reviewedAt: record.reviewedAt?.toISOString() ?? null,
    reviewedBy: record.reviewedBy,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

async function writeClinicalAudit(
  tx: Prisma.TransactionClient,
  input: {
    actorId: string;
    recordType: 'PRESCRIPTION_DRAFT' | 'MEDICATION_UPDATE';
    recordId: string;
    actionType: string;
    metadata?: Record<string, string | number | boolean | null>;
  }
) {
  await tx.clinicalWorkspaceAuditLog.create({
    data: {
      actorId: input.actorId,
      recordType: input.recordType,
      recordId: input.recordId,
      actionType: input.actionType,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    },
  });
}

// Prescription drafts are preparatory records only. There is deliberately no
// ISSUE / SIGN / DISPENSE action or pharmacy integration in this service.
clinicalWorkspaceRouter.post(
  '/prescription-drafts',
  authenticatedRouteLimiter,
  verifyJwt,
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user || !requireRole(authReq, 'THERAPIST')) {
      res
        .status(authReq.user ? 403 : 401)
        .json({ message: 'Requires THERAPIST role' });
      return;
    }

    const parsed = createPrescriptionDraftSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        message: 'Validation failed',
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const { patientId, ...payload } = parsed.data;
    const relationship = await verifyTherapistPatientRelationship(
      authReq.user.userId,
      patientId
    );
    if (relationship === null) {
      res
        .status(503)
        .json({ message: 'Appointment relationship service unavailable' });
      return;
    }
    if (!relationship) {
      res.status(403).json({ message: "Not this patient's therapist" });
      return;
    }

    let encryptedPayload: string;
    try {
      encryptedPayload = encryptClinicalPayload(
        payload as PrescriptionDraftPayload,
        'prescription-draft-v1'
      );
    } catch {
      res
        .status(503)
        .json({ message: 'Prescription draft encryption is not configured' });
      return;
    }

    const draft = await prisma.$transaction(async (tx) => {
      const created = await tx.therapistPrescriptionDraft.create({
        data: {
          therapistId: authReq.user!.userId,
          patientId,
          encryptedPayload,
          status: 'DRAFT',
        },
      });
      await writeClinicalAudit(tx, {
        actorId: authReq.user!.userId,
        recordType: 'PRESCRIPTION_DRAFT',
        recordId: created.id,
        actionType: 'PRESCRIPTION_DRAFT_CREATED',
        metadata: { status: created.status },
      });
      return created;
    });

    try {
      res
        .status(201)
        .json({ prescriptionDraft: publicPrescriptionDraft(draft) });
    } catch {
      res
        .status(503)
        .json({ message: 'Prescription draft could not be decrypted' });
    }
  })
);

clinicalWorkspaceRouter.get(
  '/prescription-drafts',
  authenticatedRouteLimiter,
  verifyJwt,
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user || !requireRole(authReq, 'THERAPIST')) {
      res
        .status(authReq.user ? 403 : 401)
        .json({ message: 'Requires THERAPIST role' });
      return;
    }

    const status =
      req.query.status === 'DRAFT' || req.query.status === 'ARCHIVED'
        ? req.query.status
        : undefined;
    if (req.query.status !== undefined && status === undefined) {
      res.status(400).json({ message: 'Invalid prescription draft status' });
      return;
    }

    const records = await prisma.therapistPrescriptionDraft.findMany({
      where: {
        therapistId: authReq.user.userId,
        ...(status ? { status } : {}),
      },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });

    try {
      res.status(200).json({
        prescriptionDrafts: records.map((record) =>
          publicPrescriptionDraft(record as PrescriptionDraftRecord)
        ),
      });
    } catch {
      res.status(503).json({
        message:
          'Prescription draft encryption key is unavailable or stored data is invalid',
      });
    }
  })
);

clinicalWorkspaceRouter.patch(
  '/prescription-drafts/:id',
  authenticatedRouteLimiter,
  verifyJwt,
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user || !requireRole(authReq, 'THERAPIST')) {
      res
        .status(authReq.user ? 403 : 401)
        .json({ message: 'Requires THERAPIST role' });
      return;
    }

    const parsed = updatePrescriptionDraftSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        message: 'Validation failed',
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const existing = await prisma.therapistPrescriptionDraft.findUnique({
      where: { id: req.params.id as string },
    });
    if (!existing || existing.therapistId !== authReq.user.userId) {
      res.status(404).json({ message: 'Prescription draft not found' });
      return;
    }
    if (existing.status !== 'DRAFT') {
      res.status(409).json({ message: 'Only a draft can be edited' });
      return;
    }

    let encryptedPayload: string;
    try {
      const current = decryptClinicalPayload<PrescriptionDraftPayload>(
        existing.encryptedPayload,
        'prescription-draft-v1'
      );
      encryptedPayload = encryptClinicalPayload(
        { ...current, ...parsed.data },
        'prescription-draft-v1'
      );
    } catch {
      res.status(503).json({
        message:
          'Prescription draft encryption is unavailable or stored data is invalid',
      });
      return;
    }

    const updated = await prisma.$transaction(async (tx) => {
      const record = await tx.therapistPrescriptionDraft.update({
        where: { id: existing.id },
        data: { encryptedPayload },
      });
      await writeClinicalAudit(tx, {
        actorId: authReq.user!.userId,
        recordType: 'PRESCRIPTION_DRAFT',
        recordId: record.id,
        actionType: 'PRESCRIPTION_DRAFT_UPDATED',
        metadata: { status: record.status },
      });
      return record;
    });

    try {
      res
        .status(200)
        .json({ prescriptionDraft: publicPrescriptionDraft(updated) });
    } catch {
      res
        .status(503)
        .json({ message: 'Updated prescription draft could not be decrypted' });
    }
  })
);

clinicalWorkspaceRouter.post(
  '/prescription-drafts/:id/archive',
  authenticatedRouteLimiter,
  verifyJwt,
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user || !requireRole(authReq, 'THERAPIST')) {
      res
        .status(authReq.user ? 403 : 401)
        .json({ message: 'Requires THERAPIST role' });
      return;
    }

    const existing = await prisma.therapistPrescriptionDraft.findUnique({
      where: { id: req.params.id as string },
    });
    if (!existing || existing.therapistId !== authReq.user.userId) {
      res.status(404).json({ message: 'Prescription draft not found' });
      return;
    }
    if (existing.status !== 'DRAFT') {
      res.status(409).json({ message: 'Only a draft can be archived' });
      return;
    }

    const updated = await prisma.$transaction(async (tx) => {
      const record = await tx.therapistPrescriptionDraft.update({
        where: { id: existing.id },
        data: { status: 'ARCHIVED' },
      });
      await writeClinicalAudit(tx, {
        actorId: authReq.user!.userId,
        recordType: 'PRESCRIPTION_DRAFT',
        recordId: record.id,
        actionType: 'PRESCRIPTION_DRAFT_ARCHIVED',
        metadata: { status: record.status },
      });
      return record;
    });

    try {
      res
        .status(200)
        .json({ prescriptionDraft: publicPrescriptionDraft(updated) });
    } catch {
      res.status(503).json({
        message: 'Archived prescription draft could not be decrypted',
      });
    }
  })
);

// Patients can submit a medication-related update for a therapist they have
// actually seen. This creates a review request; it does not alter a treatment
// record, issue a prescription or change a medication list.
clinicalWorkspaceRouter.post(
  '/medication-updates',
  authenticatedRouteLimiter,
  verifyJwt,
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user || !requireRole(authReq, 'PATIENT')) {
      res
        .status(authReq.user ? 403 : 401)
        .json({ message: 'Requires PATIENT role' });
      return;
    }

    const parsed = createMedicationUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        message: 'Validation failed',
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const { therapistId, ...payload } = parsed.data;
    const relationship = await verifyTherapistPatientRelationship(
      therapistId,
      authReq.user.userId
    );
    if (relationship === null) {
      res
        .status(503)
        .json({ message: 'Appointment relationship service unavailable' });
      return;
    }
    if (!relationship) {
      res.status(403).json({
        message:
          'You can only send medication updates to a therapist you have seen',
      });
      return;
    }

    let encryptedPayload: string;
    try {
      encryptedPayload = encryptClinicalPayload(
        { ...payload, reviewNote: '' } as MedicationUpdatePayload,
        'medication-update-v1'
      );
    } catch {
      res
        .status(503)
        .json({ message: 'Medication update encryption is not configured' });
      return;
    }

    const update = await prisma.$transaction(async (tx) => {
      const created = await tx.medicationUpdateRequest.create({
        data: {
          therapistId,
          patientId: authReq.user!.userId,
          encryptedPayload,
          status: 'PENDING',
        },
      });
      await writeClinicalAudit(tx, {
        actorId: authReq.user!.userId,
        recordType: 'MEDICATION_UPDATE',
        recordId: created.id,
        actionType: 'MEDICATION_UPDATE_SUBMITTED',
        metadata: { status: created.status },
      });
      return created;
    });

    try {
      res
        .status(201)
        .json({ medicationUpdate: publicMedicationUpdate(update) });
    } catch {
      res
        .status(503)
        .json({ message: 'Medication update could not be decrypted' });
    }
  })
);

clinicalWorkspaceRouter.get(
  '/medication-updates/mine',
  authenticatedRouteLimiter,
  verifyJwt,
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user || !requireRole(authReq, 'PATIENT')) {
      res
        .status(authReq.user ? 403 : 401)
        .json({ message: 'Requires PATIENT role' });
      return;
    }

    const records = await prisma.medicationUpdateRequest.findMany({
      where: { patientId: authReq.user.userId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    try {
      res.status(200).json({
        medicationUpdates: records.map((record) =>
          publicMedicationUpdate(record as MedicationUpdateRecord)
        ),
      });
    } catch {
      res.status(503).json({
        message:
          'Medication update encryption key is unavailable or stored data is invalid',
      });
    }
  })
);

clinicalWorkspaceRouter.get(
  '/medication-reviews',
  authenticatedRouteLimiter,
  verifyJwt,
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user || !requireRole(authReq, 'THERAPIST')) {
      res
        .status(authReq.user ? 403 : 401)
        .json({ message: 'Requires THERAPIST role' });
      return;
    }

    const status =
      req.query.status === 'PENDING' ||
      req.query.status === 'REVIEWED' ||
      req.query.status === 'FOLLOW_UP_REQUIRED'
        ? req.query.status
        : undefined;
    if (req.query.status !== undefined && status === undefined) {
      res.status(400).json({ message: 'Invalid medication review status' });
      return;
    }

    const records = await prisma.medicationUpdateRequest.findMany({
      where: {
        therapistId: authReq.user.userId,
        ...(status ? { status } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    try {
      res.status(200).json({
        medicationReviews: records.map((record) =>
          publicMedicationUpdate(record as MedicationUpdateRecord)
        ),
      });
    } catch {
      res.status(503).json({
        message:
          'Medication review encryption key is unavailable or stored data is invalid',
      });
    }
  })
);

clinicalWorkspaceRouter.patch(
  '/medication-reviews/:id',
  authenticatedRouteLimiter,
  verifyJwt,
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user || !requireRole(authReq, 'THERAPIST')) {
      res
        .status(authReq.user ? 403 : 401)
        .json({ message: 'Requires THERAPIST role' });
      return;
    }

    const parsed = reviewMedicationUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        message: 'Validation failed',
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const existing = await prisma.medicationUpdateRequest.findUnique({
      where: { id: req.params.id as string },
    });
    if (!existing || existing.therapistId !== authReq.user.userId) {
      res.status(404).json({ message: 'Medication update not found' });
      return;
    }
    if (existing.status === 'REVIEWED') {
      res
        .status(409)
        .json({ message: 'This medication update has already been reviewed' });
      return;
    }

    let encryptedPayload: string;
    try {
      const current = decryptClinicalPayload<MedicationUpdatePayload>(
        existing.encryptedPayload,
        'medication-update-v1'
      );
      encryptedPayload = encryptClinicalPayload(
        { ...current, reviewNote: parsed.data.reviewNote },
        'medication-update-v1'
      );
    } catch {
      res.status(503).json({
        message:
          'Medication review encryption is unavailable or stored data is invalid',
      });
      return;
    }

    const updated = await prisma.$transaction(async (tx) => {
      const record = await tx.medicationUpdateRequest.update({
        where: { id: existing.id },
        data: {
          encryptedPayload,
          status: parsed.data.status as MedicationReviewStatus,
          reviewedAt: new Date(),
          reviewedBy: authReq.user!.userId,
        },
      });
      await writeClinicalAudit(tx, {
        actorId: authReq.user!.userId,
        recordType: 'MEDICATION_UPDATE',
        recordId: record.id,
        actionType: 'MEDICATION_UPDATE_REVIEWED',
        metadata: { status: record.status },
      });
      return record;
    });

    try {
      res
        .status(200)
        .json({ medicationUpdate: publicMedicationUpdate(updated) });
    } catch {
      res
        .status(503)
        .json({ message: 'Reviewed medication update could not be decrypted' });
    }
  })
);
