import { describe, expect, it } from 'vitest';
import { runPreFilter } from '../preFilter.js';

describe('runPreFilter', () => {
  it('clean message returns 0', async () => {
    expect(await runPreFilter('Hello, how are you today?')).toBe(0);
  });

  it('Level 1 phrase returns 1', async () => {
    expect(await runPreFilter('I feel so sad and lonely')).toBe(1);
  });

  it('Level 3 phrase returns 3', async () => {
    expect(await runPreFilter('I want to die')).toBe(3);
  });

  it('Level 5 phrase returns 5', async () => {
    expect(await runPreFilter("I'm going to kill myself")).toBe(5);
  });

  it('message containing both a Level 1 and a Level 5 phrase returns 5, not 1', async () => {
    expect(await runPreFilter("I feel so sad. I'm going to kill myself")).toBe(
      5
    );
  });

  it('Level 5 phrase in ALL CAPS returns 5 (normalisation)', async () => {
    expect(await runPreFilter("I'M GOING TO KILL MYSELF")).toBe(5);
  });

  it('"I want to die!!!" returns 3 (punctuation stripping)', async () => {
    expect(await runPreFilter('I want to die!!!')).toBe(3);
  });

  it.each([
    ['I am thinking about suicide', 5],
    ['I keep thinking about suicide', 4],
    ['I might hurt myself', 5],
    ['I cannot keep myself safe', 5],
    ['I have already hurt myself', 5],
    ['I have suicidal thoughts', 4],
    ['Suicide is on my mind', 4],
    ['I have urges to hurt myself', 4],
    ['I cut myself', 4],
    ['I do not trust myself to stay safe', 5],
    ['I am afraid I will hurt myself', 5],
    ['I wish I was dead', 3],
  ])(
    'detects varied English crisis disclosure: %s',
    async (message, expected) => {
      expect(await runPreFilter(message)).toBe(expected);
    }
  );

  it('does not classify neutral possession of a kitchen knife as self-harm by itself', async () => {
    expect(await runPreFilter('I have a knife to prepare dinner')).toBe(0);
  });

  it('does not flag a neutral discussion of suicide prevention as a personal crisis disclosure', async () => {
    expect(
      await runPreFilter('My favourite film is about suicide prevention')
    ).toBe(0);
  });

  it('empty string returns 0', async () => {
    expect(await runPreFilter('')).toBe(0);
  });
});
