import { describe, expect, it } from 'vitest';
import { scoreScreening } from './screening-scoring.js';

const answers = (values: number[]) =>
  Object.fromEntries(values.map((value, index) => [index, value]));

describe('screening scoring parity with public frontend rules', () => {
  it('scores GAD-7 with the public 0–21 sum and severity wording', () => {
    expect(scoreScreening('gad7', answers([0, 1, 2, 3, 0, 1, 2]))).toEqual({
      rawScore: 9,
      displayScore: '9',
      maxScore: '21',
      severity: 'Mild',
      label: 'Mild Anxiety',
      interpretation:
        'Your responses suggest mild anxiety. Many people feel better with small routines, rest, and talking with someone they trust.',
    });
  });

  it('scores DASS-21 depression using the public doubled subscale sum', () => {
    expect(
      scoreScreening('dass21-depression', answers(Array(7).fill(2)))
    ).toEqual({
      rawScore: 28,
      displayScore: '28',
      maxScore: '42',
      severity: 'Extremely Severe',
      label: 'Extremely Severe Depression',
      interpretation:
        'Your responses suggest extremely severe low mood. Please consider speaking with a mental health professional as soon as you can. If you need urgent support, use the crisis line in the app.',
    });
  });

  it('scores DASS-21 anxiety using the public doubled subscale sum', () => {
    expect(scoreScreening('dass21-anxiety', answers(Array(7).fill(2)))).toEqual(
      {
        rawScore: 28,
        displayScore: '28',
        maxScore: '42',
        severity: 'Extremely Severe',
        label: 'Extremely Severe Anxiety',
        interpretation:
          'Your responses suggest extremely severe anxiety. Please consider speaking with a mental health professional as soon as you can. If you need urgent support, use the crisis line in the app.',
      }
    );
  });

  it('scores DASS-21 stress using the public doubled subscale sum', () => {
    expect(scoreScreening('dass21-stress', answers(Array(7).fill(2)))).toEqual({
      rawScore: 28,
      displayScore: '28',
      maxScore: '42',
      severity: 'Severe',
      label: 'Severe Stress',
      interpretation:
        'Your responses suggest severe stress. You do not have to manage this alone — a licensed therapist can help you take the next step.',
    });
  });

  it('scores ASRS from the first six threshold indicators, as the public scorer does', () => {
    expect(
      scoreScreening('asrs', answers([3, 3, 3, 3, 0, 0, ...Array(12).fill(4)]))
    ).toEqual({
      rawScore: 4,
      displayScore: '4',
      maxScore: '6 primary indicators',
      severity: 'Consistent',
      label:
        'Symptoms highly consistent with ADHD — further evaluation recommended',
      interpretation:
        'Your primary-screener answers are highly consistent with ADHD. Further evaluation with a qualified clinician is recommended.',
      extras: [
        {
          label: 'Primary indicators',
          value: '4 out of 6 primary indicators present',
        },
      ],
    });
  });

  it('scores CYBOCS and returns the public obsession and compulsion subtotals', () => {
    expect(
      scoreScreening('cybocs', answers([0, 1, 2, 3, 4, 0, 1, 2, 3, 4]))
    ).toEqual({
      rawScore: 20,
      displayScore: '20',
      maxScore: '40',
      severity: 'Moderate',
      label: 'Moderate OCD symptoms',
      interpretation:
        'Your responses suggest moderate obsessive-compulsive symptoms. This can be a good moment to connect with a therapist who can help you make sense of what you are carrying.',
      extras: [
        { label: 'Obsession subtotal', value: '10 / 20' },
        { label: 'Compulsion subtotal', value: '10 / 20' },
      ],
    });
  });
});
