import { randomUUID } from 'node:crypto';
import { screeningSubmissionSchema } from '@mindora/validation';
import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import {
  encryptScreeningAnswers,
  ScreeningEncryptionConfigurationError,
} from '../lib/screening-crypto.js';
import {
  SCREENING_SCORING_VERSION,
  scoreScreening,
} from '../lib/screening-scoring.js';
import {
  verifyJwt,
  type AuthenticatedRequest,
} from '../middleware/authenticate.js';
import { authenticatedRouteLimiter } from '../middleware/rate-limit.js';
import { asyncHandler } from '../middleware/async-handler.js';

export const screeningRouter = Router();

screeningRouter.post(
  '/screenings',
  authenticatedRouteLimiter,
  verifyJwt,
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user) {
      res.status(401).json({ message: 'Unauthorized' });
      return;
    }
    if (authReq.user.role !== 'PATIENT') {
      res.status(403).json({ message: 'Requires PATIENT role' });
      return;
    }

    const parsed = screeningSubmissionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        message: 'Validation failed',
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const answers = Object.fromEntries(
      Object.entries(parsed.data.answers).map(([index, value]) => [
        Number(index),
        value,
      ])
    );
    const result = scoreScreening(parsed.data.instrumentId, answers);

    let answersEncrypted: string;
    try {
      answersEncrypted = encryptScreeningAnswers(answers);
    } catch (error) {
      if (error instanceof ScreeningEncryptionConfigurationError) {
        res.status(503).json({
          message:
            'Screening submissions are unavailable because encryption is not configured',
        });
        return;
      }
      throw error;
    }

    const saved = await prisma.screeningResult.create({
      data: {
        id: randomUUID(),
        userId: authReq.user.userId,
        instrumentId: parsed.data.instrumentId,
        scoringVersion: SCREENING_SCORING_VERSION,
        answersEncrypted,
        rawScore: result.rawScore,
        displayScore: result.displayScore,
        maxScore: result.maxScore,
        severity: result.severity,
        label: result.label,
        interpretation: result.interpretation,
        ...(result.extras ? { extras: result.extras } : {}),
      },
    });

    res.status(201).json({
      id: saved.id,
      patientId: saved.userId,
      instrumentId: saved.instrumentId,
      scoringVersion: saved.scoringVersion,
      rawScore: saved.rawScore,
      displayScore: saved.displayScore,
      maxScore: saved.maxScore,
      severity: saved.severity,
      label: saved.label,
      interpretation: saved.interpretation,
      ...(saved.extras == null ? {} : { extras: saved.extras }),
      completedAt: saved.completedAt,
      createdAt: saved.createdAt,
    });
  })
);
