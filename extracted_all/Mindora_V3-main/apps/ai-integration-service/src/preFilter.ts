// ⚠️  CLINICAL REVIEW REQUIRED
// This keyword list was defined by the engineering team as a technical starting point.
// It has NOT been reviewed by a mental health professional, crisis counselor, or
// clinical psychologist. Before Mindora V3 goes live with real users, this list
// MUST be reviewed and approved by a qualified clinician.
// Reference frameworks for review: Columbia Suicide Severity Rating Scale (C-SSRS),
// AFSP Safe Messaging Guidelines.

const CRISIS_KEYWORDS: Record<number, string[]> = {
  1: [
    'sad',
    'anxious',
    'stressed',
    'overwhelmed',
    'exhausted',
    'hopeless',
    'lonely',
    'numb',
    'empty',
    'worthless',
    'trapped',
    'afraid',
    'scared',
    'panic',
    'crying',
    "can't sleep",
    "can't eat",
  ],
  2: [
    "can't go on",
    'no reason to live',
    "what's the point",
    'nobody cares',
    'everyone would be better off',
    "i'm a burden",
    'i dont matter',
    'i give up',
    "i can't do this anymore",
    'i want to disappear',
    "i wish i wasn't here",
  ],
  3: [
    "i don't want to be alive",
    'i wish i was dead',
    'i want to die',
    'i want it all to end',
    'i want to stop existing',
    "life isn't worth living",
    "i'd be better off dead",
    'i think about death a lot',
    'dying would be a relief',
  ],
  4: [
    'i want to kill myself',
    "i'm thinking about suicide",
    'thinking about ending my life',
    'suicidal thoughts',
    'suicidal ideation',
    'thinking of suicide',
    'thinking about killing myself',
    'thoughts of killing myself',
    'thoughts of self harm',
    'i have thoughts of hurting myself',
    'i am thinking about hurting myself',
    'i keep thinking about suicide',
    'i have suicidal thoughts',
    'suicide is on my mind',
    'i keep thinking of suicide',
    'i am thinking about self harm',
    'i have thoughts of self injury',
    'i have urges to hurt myself',
    'i cut myself',
    'i have cut myself',
    'i am self harming',
    'urge to self harm',
    'i have been self harming',
    'i self harm',
    "i've thought about hurting myself",
    'i want to hurt myself',
    'self harm',
    'cutting myself',
    "i've been cutting",
  ],
  5: [
    "i'm going to kill myself",
    "i'm going to end my life",
    'i have a plan to die',
    "i've decided to end it",
    "i'm going to do it tonight",
    "i've already taken pills",
    "i've already hurt myself",
    'i have already hurt myself',
    'i have access to a gun and might hurt myself',
    'i have access to a knife and might hurt myself',
    'i might hurt myself',
    'i am going to hurt myself',
    'i am thinking of hurting myself',
    'i am thinking about suicide',
    'i want to end my life',
    'i plan to end my life',
    'i cannot keep myself safe',
    'i cant keep myself safe',
    'i might kill myself',
    'i do not trust myself to stay safe',
    'i dont trust myself to stay safe',
    'i am afraid i will hurt myself',
    'i am going to cut myself',
    'i took something to hurt myself',
    'i might end my life',
    'i have already attempted suicide',
    'i am about to overdose',
    'i took pills to end my life',
    'i cannot promise i will stay safe',
    'i will hurt myself tonight',
    'i took an overdose',
    'i overdosed',
    "i'm saying goodbye",
    'this is my last message',
    "i won't be here tomorrow",
  ],
};

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, '') // strip all punctuation (prevents "I WANT TO DIE!!!" escaping a match)
    .replace(/\s+/g, ' ') // collapse multiple spaces created by stripping
    .trim();
}

// Pre-normalise keywords once at module load — the same transform applied to input
// must be applied here so apostrophes ("can't" → "cant") align on both sides.
const NORMALISED_KEYWORDS: Record<number, string[]> = Object.fromEntries(
  (Object.entries(CRISIS_KEYWORDS) as [string, string[]][]).map(
    ([level, phrases]) => [Number(level), phrases.map(normalise)]
  )
);

export async function runPreFilter(
  message: string,
  userId?: string
): Promise<number> {
  const normalised = normalise(message);

  // Check highest level first so a message matching both Level 1 and Level 5
  // always returns 5, never the lower level.
  for (const level of [5, 4, 3, 2, 1] as const) {
    if (
      NORMALISED_KEYWORDS[level].some((phrase) => normalised.includes(phrase))
    ) {
      console.log(
        `[pre-filter] crisis_level=${level} userId=${userId ?? 'unknown'}`
      );
      return level;
    }
  }

  return 0;
}
