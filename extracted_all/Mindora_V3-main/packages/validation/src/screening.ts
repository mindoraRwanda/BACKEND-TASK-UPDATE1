import { z } from 'zod';

export const SCREENING_INSTRUMENTS = {
  gad7: { questionCount: 7, maxAnswer: 3 },
  'dass21-depression': { questionCount: 7, maxAnswer: 3 },
  'dass21-anxiety': { questionCount: 7, maxAnswer: 3 },
  'dass21-stress': { questionCount: 7, maxAnswer: 3 },
  asrs: { questionCount: 18, maxAnswer: 4 },
  cybocs: { questionCount: 10, maxAnswer: 4 },
} as const;

export type ScreeningInstrumentId = keyof typeof SCREENING_INSTRUMENTS;

const screeningInstrumentIdSchema = z.enum([
  'gad7',
  'dass21-depression',
  'dass21-anxiety',
  'dass21-stress',
  'asrs',
  'cybocs',
]);

export const screeningSubmissionSchema = z
  .object({
    instrumentId: screeningInstrumentIdSchema,
    answers: z.record(z.string(), z.number().int()),
  })
  .strict()
  .superRefine((submission, context) => {
    const definition = SCREENING_INSTRUMENTS[submission.instrumentId];
    const expectedKeys = Array.from(
      { length: definition.questionCount },
      (_, index) => String(index)
    );
    const actualKeys = Object.keys(submission.answers);

    if (
      actualKeys.length !== expectedKeys.length ||
      expectedKeys.some((key) => !Object.hasOwn(submission.answers, key))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['answers'],
        message: `Expected answers for indexes 0 through ${definition.questionCount - 1}`,
      });
    }

    for (const [index, value] of Object.entries(submission.answers)) {
      if (
        !expectedKeys.includes(index) ||
        value < 0 ||
        value > definition.maxAnswer
      ) {
        context.addIssue({
          code: 'custom',
          path: ['answers', index],
          message: `Answer must be an integer from 0 to ${definition.maxAnswer} at a valid question index`,
        });
      }
    }
  });

export type ScreeningSubmissionDto = z.infer<typeof screeningSubmissionSchema>;
