import { afterEach, describe, expect, it } from 'vitest';
import {
  decryptScreeningAnswers,
  encryptScreeningAnswers,
  ScreeningDecryptionError,
  ScreeningEncryptionConfigurationError,
} from './screening-crypto.js';

const originalKey = process.env.SCREENING_ENCRYPTION_KEY;
const testKey = Buffer.alloc(32, 7).toString('base64');

function replacePayloadPart(payload: string, partIndex: number, value: string) {
  const parts = payload.split(':');
  parts[partIndex] = value;
  return parts.join(':');
}

afterEach(() => {
  if (originalKey === undefined) {
    delete process.env.SCREENING_ENCRYPTION_KEY;
  } else {
    process.env.SCREENING_ENCRYPTION_KEY = originalKey;
  }
});

describe('screening answer encryption', () => {
  it('encrypts answers with authenticated encryption and round trips', () => {
    process.env.SCREENING_ENCRYPTION_KEY = testKey;
    const answers = { 0: 1, 1: 3, 2: 0 };
    const encrypted = encryptScreeningAnswers(answers);

    expect(encrypted).toMatch(/^v1:/);
    expect(encrypted).not.toContain(JSON.stringify(answers));
    expect(decryptScreeningAnswers(encrypted)).toEqual(answers);
  });

  it('fails closed when the dedicated key is absent', () => {
    delete process.env.SCREENING_ENCRYPTION_KEY;
    expect(() => encryptScreeningAnswers({ 0: 1 })).toThrow(
      ScreeningEncryptionConfigurationError
    );
  });

  it('fails closed when the dedicated key is not valid base64 for 32 bytes', () => {
    process.env.SCREENING_ENCRYPTION_KEY = 'not-a-valid-key';
    expect(() => encryptScreeningAnswers({ 0: 1 })).toThrow(
      ScreeningEncryptionConfigurationError
    );
  });

  it('rejects malformed payload structure and non-canonical base64 safely', () => {
    process.env.SCREENING_ENCRYPTION_KEY = testKey;
    const encrypted = encryptScreeningAnswers({ 0: 1 });

    for (const malformed of [
      `${encrypted}:extra`,
      encrypted.replace(/^v1:/, 'v2:'),
      replacePayloadPart(encrypted, 1, '%%%'),
      replacePayloadPart(encrypted, 4, 'not-base64'),
      replacePayloadPart(encrypted, 4, ''),
    ]) {
      expect(() => decryptScreeningAnswers(malformed)).toThrow(
        ScreeningDecryptionError
      );
      expect(() => decryptScreeningAnswers(malformed)).toThrow(
        'Invalid encrypted screening answers'
      );
    }
  });

  it('requires a 12-byte IV and a 16-byte GCM authentication tag', () => {
    process.env.SCREENING_ENCRYPTION_KEY = testKey;
    const encrypted = encryptScreeningAnswers({ 0: 1 });

    expect(() =>
      decryptScreeningAnswers(
        replacePayloadPart(encrypted, 1, Buffer.alloc(11).toString('base64'))
      )
    ).toThrow(ScreeningDecryptionError);
    expect(() =>
      decryptScreeningAnswers(
        replacePayloadPart(encrypted, 2, Buffer.alloc(15).toString('base64'))
      )
    ).toThrow(ScreeningDecryptionError);
  });

  it('rejects tampered IV, tag, and ciphertext without exposing crypto errors', () => {
    process.env.SCREENING_ENCRYPTION_KEY = testKey;
    const encrypted = encryptScreeningAnswers({ 0: 1 });
    const parts = encrypted.split(':');
    const tamperedPayloads = [1, 2, 3].map((partIndex) => {
      const bytes = Buffer.from(parts[partIndex + 0] ?? '', 'base64');
      bytes[0] = (bytes[0] ?? 0) ^ 1;
      return replacePayloadPart(encrypted, partIndex, bytes.toString('base64'));
    });

    for (const tampered of tamperedPayloads) {
      expect(() => decryptScreeningAnswers(tampered)).toThrow(
        ScreeningDecryptionError
      );
      expect(() => decryptScreeningAnswers(tampered)).toThrow(
        'Invalid encrypted screening answers'
      );
    }
  });
});
