import {
  SCREENING_INSTRUMENTS,
  type ScreeningInstrumentId,
} from '@mindora/validation';

export const SCREENING_SCORING_VERSION = 'public-screenings-v1';

export type ScreeningSeverity =
  | 'Normal'
  | 'Minimal'
  | 'Mild'
  | 'Moderate'
  | 'Severe'
  | 'Extremely Severe'
  | 'Subclinical'
  | 'Extreme'
  | 'Not consistent'
  | 'Consistent';

export interface ScreeningResultValue {
  rawScore: number;
  displayScore: string;
  maxScore: string;
  severity: ScreeningSeverity;
  label: string;
  interpretation: string;
  extras?: { label: string; value: string }[];
}

export type ScreeningAnswers = Record<number, number>;

function sumAnswers(answers: ScreeningAnswers): number {
  return Object.values(answers).reduce((total, value) => total + value, 0);
}

function interpret(level: ScreeningSeverity, topic: string): string {
  const copy: Record<ScreeningSeverity, string> = {
    Normal: `Your responses fall in the typical range for ${topic}. Keep noticing how you feel, and reach out if things change.`,
    Minimal: `Your responses suggest minimal ${topic}. This is a gentle snapshot, not a diagnosis — support is still available if you want it.`,
    Mild: `Your responses suggest mild ${topic}. Many people feel better with small routines, rest, and talking with someone they trust.`,
    Moderate: `Your responses suggest moderate ${topic}. This can be a good moment to connect with a therapist who can help you make sense of what you are carrying.`,
    Severe: `Your responses suggest severe ${topic}. You do not have to manage this alone — a licensed therapist can help you take the next step.`,
    'Extremely Severe': `Your responses suggest extremely severe ${topic}. Please consider speaking with a mental health professional as soon as you can. If you need urgent support, use the crisis line in the app.`,
    Subclinical: `Your responses are in a subclinical range for ${topic}. Symptoms may be present but not strongly interfering right now.`,
    Extreme: `Your responses suggest extreme ${topic}. Please consider professional support promptly, especially if daily life feels hard to manage.`,
    'Not consistent': `Your primary-screener answers are not highly consistent with ADHD. This does not rule anything out — a clinician can still help if you have concerns.`,
    Consistent: `Your primary-screener answers are highly consistent with ADHD. Further evaluation with a qualified clinician is recommended.`,
  };
  return copy[level];
}

export function scoreScreening(
  instrumentId: ScreeningInstrumentId,
  answers: ScreeningAnswers
): ScreeningResultValue {
  if (instrumentId === 'gad7') {
    const rawScore = sumAnswers(answers);
    const severity: ScreeningSeverity =
      rawScore <= 4
        ? 'Minimal'
        : rawScore <= 9
          ? 'Mild'
          : rawScore <= 14
            ? 'Moderate'
            : 'Severe';
    return {
      rawScore,
      displayScore: String(rawScore),
      maxScore: '21',
      severity,
      label: `${severity} Anxiety`,
      interpretation: interpret(severity, 'anxiety'),
    };
  }

  if (instrumentId === 'dass21-anxiety') {
    const rawScore = sumAnswers(answers) * 2;
    const severity: ScreeningSeverity =
      rawScore <= 7
        ? 'Normal'
        : rawScore <= 9
          ? 'Mild'
          : rawScore <= 14
            ? 'Moderate'
            : rawScore <= 19
              ? 'Severe'
              : 'Extremely Severe';
    return {
      rawScore,
      displayScore: String(rawScore),
      maxScore: '42',
      severity,
      label: `${severity} Anxiety`,
      interpretation: interpret(severity, 'anxiety'),
    };
  }

  if (instrumentId === 'dass21-stress') {
    const rawScore = sumAnswers(answers) * 2;
    const severity: ScreeningSeverity =
      rawScore <= 14
        ? 'Normal'
        : rawScore <= 18
          ? 'Mild'
          : rawScore <= 25
            ? 'Moderate'
            : rawScore <= 33
              ? 'Severe'
              : 'Extremely Severe';
    return {
      rawScore,
      displayScore: String(rawScore),
      maxScore: '42',
      severity,
      label: `${severity} Stress`,
      interpretation: interpret(severity, 'stress'),
    };
  }

  if (instrumentId === 'dass21-depression') {
    const rawScore = sumAnswers(answers) * 2;
    const severity: ScreeningSeverity =
      rawScore <= 9
        ? 'Normal'
        : rawScore <= 13
          ? 'Mild'
          : rawScore <= 20
            ? 'Moderate'
            : rawScore <= 27
              ? 'Severe'
              : 'Extremely Severe';
    return {
      rawScore,
      displayScore: String(rawScore),
      maxScore: '42',
      severity,
      label: `${severity} Depression`,
      interpretation: interpret(severity, 'low mood'),
    };
  }

  if (instrumentId === 'asrs') {
    const indicators = [0, 1, 2, 3, 4, 5].filter(
      (index) => (answers[index] ?? 0) >= 3
    ).length;
    const consistent = indicators >= 4;
    return {
      rawScore: indicators,
      displayScore: String(indicators),
      maxScore: '6 primary indicators',
      severity: consistent ? 'Consistent' : 'Not consistent',
      label: consistent
        ? 'Symptoms highly consistent with ADHD — further evaluation recommended'
        : 'Symptoms not highly consistent with ADHD',
      interpretation: interpret(
        consistent ? 'Consistent' : 'Not consistent',
        'attention and activity'
      ),
      extras: [
        {
          label: 'Primary indicators',
          value: `${indicators} out of 6 primary indicators present`,
        },
      ],
    };
  }

  const obsession = [0, 1, 2, 3, 4].reduce(
    (total, index) => total + (answers[index] ?? 0),
    0
  );
  const compulsion = [5, 6, 7, 8, 9].reduce(
    (total, index) => total + (answers[index] ?? 0),
    0
  );
  const rawScore = obsession + compulsion;
  const severity: ScreeningSeverity =
    rawScore <= 7
      ? 'Subclinical'
      : rawScore <= 15
        ? 'Mild'
        : rawScore <= 23
          ? 'Moderate'
          : rawScore <= 31
            ? 'Severe'
            : 'Extreme';
  return {
    rawScore,
    displayScore: String(rawScore),
    maxScore: '40',
    severity,
    label: `${severity} OCD symptoms`,
    interpretation: interpret(severity, 'obsessive-compulsive symptoms'),
    extras: [
      { label: 'Obsession subtotal', value: `${obsession} / 20` },
      { label: 'Compulsion subtotal', value: `${compulsion} / 20` },
    ],
  };
}

export function getScreeningQuestionCount(
  instrumentId: ScreeningInstrumentId
): number {
  return SCREENING_INSTRUMENTS[instrumentId].questionCount;
}
