import crypto from 'crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { decryptUserId, encryptUserId } from './encryption.js';

const legacyKey = Buffer.from(
  'mindora-dev-community-key-32bytes!!',
  'utf8'
).slice(0, 32);

function encryptWithKey(value: string, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(value, 'utf8'),
    cipher.final(),
  ]);
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${encrypted.toString('hex')}`;
}

const originalKey = process.env.COMMUNITY_ENCRYPTION_KEY;
const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  if (originalKey === undefined) delete process.env.COMMUNITY_ENCRYPTION_KEY;
  else process.env.COMMUNITY_ENCRYPTION_KEY = originalKey;
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
});

describe('community encryption key rotation', () => {
  it('decrypts existing records encrypted with the legacy default after a new key is configured', () => {
    process.env.NODE_ENV = 'test';
    process.env.COMMUNITY_ENCRYPTION_KEY =
      'new-community-key-for-production-rotation-32bytes';
    const legacyCiphertext = encryptWithKey('patient-123', legacyKey);
    expect(decryptUserId(legacyCiphertext)).toBe('patient-123');
  });

  it('encrypts and decrypts new records with the configured key', () => {
    process.env.NODE_ENV = 'test';
    process.env.COMMUNITY_ENCRYPTION_KEY =
      'new-community-key-for-production-rotation-32bytes';
    const ciphertext = encryptUserId('patient-456');
    expect(decryptUserId(ciphertext)).toBe('patient-456');
  });

  it('refuses new production writes when the dedicated key is missing', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.COMMUNITY_ENCRYPTION_KEY;
    expect(() => encryptUserId('patient-789')).toThrow(
      'COMMUNITY_ENCRYPTION_KEY is required for production writes'
    );
  });
});
