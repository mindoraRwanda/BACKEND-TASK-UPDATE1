import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

export class ScreeningEncryptionConfigurationError extends Error {
  constructor() {
    super(
      'SCREENING_ENCRYPTION_KEY must be configured as base64-encoded 32-byte key'
    );
    this.name = 'ScreeningEncryptionConfigurationError';
  }
}

export class ScreeningDecryptionError extends Error {
  constructor() {
    super('Invalid encrypted screening answers');
    this.name = 'ScreeningDecryptionError';
  }
}

function encryptionKey(): Buffer {
  const encodedKey = process.env.SCREENING_ENCRYPTION_KEY;
  if (!encodedKey) {
    throw new ScreeningEncryptionConfigurationError();
  }

  const key = Buffer.from(encodedKey, 'base64');
  if (key.length !== KEY_BYTES || key.toString('base64') !== encodedKey) {
    throw new ScreeningEncryptionConfigurationError();
  }
  return key;
}

export function encryptScreeningAnswers(
  answers: Record<number, number>
): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, encryptionKey(), iv, {
    authTagLength: AUTH_TAG_BYTES,
  });
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(answers), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

export function decryptScreeningAnswers(
  payload: string
): Record<number, number> {
  // Resolve configuration separately so a missing/invalid key retains its
  // actionable configuration error instead of being reported as bad data.
  const key = encryptionKey();
  if (typeof payload !== 'string') {
    throw new ScreeningDecryptionError();
  }

  const parts = payload.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new ScreeningDecryptionError();
  }

  const [encodedIv, encodedTag, encodedCiphertext] = parts.slice(1);
  const decodeBase64 = (value: string | undefined): Buffer => {
    if (!value) throw new ScreeningDecryptionError();
    const decoded = Buffer.from(value, 'base64');
    if (decoded.toString('base64') !== value) {
      throw new ScreeningDecryptionError();
    }
    return decoded;
  };

  const iv = decodeBase64(encodedIv);
  const tag = decodeBase64(encodedTag);
  const ciphertext = decodeBase64(encodedCiphertext);
  if (
    iv.length !== IV_BYTES ||
    tag.length !== AUTH_TAG_BYTES ||
    ciphertext.length === 0
  ) {
    throw new ScreeningDecryptionError();
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv, {
      authTagLength: AUTH_TAG_BYTES,
    });
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    const answers: unknown = JSON.parse(decrypted.toString('utf8'));
    if (
      answers === null ||
      typeof answers !== 'object' ||
      Array.isArray(answers) ||
      Object.entries(answers).some(
        ([index, value]) =>
          !/^(0|[1-9]\d*)$/.test(index) ||
          typeof value !== 'number' ||
          !Number.isInteger(value)
      )
    ) {
      throw new ScreeningDecryptionError();
    }
    return answers as Record<number, number>;
  } catch {
    // Do not leak whether authentication, UTF-8/JSON parsing, or shape checks
    // failed, nor surface low-level crypto details to callers.
    throw new ScreeningDecryptionError();
  }
}
