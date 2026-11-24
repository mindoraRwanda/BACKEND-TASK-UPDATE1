import crypto from 'crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { decryptContent, encryptContent } from './encryption.js';

const legacyKey = Buffer.from(
  'mindora-dev-message-key-32bytes!!',
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


function decryptWithKey(value: string, key: Buffer): string {
  const [ivHex, authTagHex, dataHex] = value.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataHex, 'hex')),
    decipher.final(),
  ]).toString('utf8');
}

const originalKey = process.env.MESSAGE_ENCRYPTION_KEY;
const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  if (originalKey === undefined) delete process.env.MESSAGE_ENCRYPTION_KEY;
  else process.env.MESSAGE_ENCRYPTION_KEY = originalKey;
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
});

describe('message encryption key rotation', () => {
  it('decrypts existing records encrypted with the legacy default after a new key is configured', () => {
    process.env.NODE_ENV = 'test';
    process.env.MESSAGE_ENCRYPTION_KEY =
      'new-message-key-for-production-rotation-32bytes';
    const legacyCiphertext = encryptWithKey('A private message', legacyKey);
    expect(decryptContent(legacyCiphertext)).toBe('A private message');
  });

  it('encrypts and decrypts new messages with the configured key', () => {
    process.env.NODE_ENV = 'test';
    process.env.MESSAGE_ENCRYPTION_KEY =
      'new-message-key-for-production-rotation-32bytes';
    const ciphertext = encryptContent('A new private message');
    expect(decryptContent(ciphertext)).toBe('A new private message');
  });

  it('decodes 32-byte hexadecimal keys before encrypting new messages', () => {
    process.env.NODE_ENV = 'test';
    const hexKey = '0123456789abcdef'.repeat(4);
    process.env.MESSAGE_ENCRYPTION_KEY = hexKey;
    const ciphertext = encryptContent('A message with a hexadecimal key');
    expect(decryptWithKey(ciphertext, Buffer.from(hexKey, 'hex'))).toBe(
      'A message with a hexadecimal key'
    );
  }),

  it('preserves existing plaintext records', () => {
    process.env.NODE_ENV = 'test';
    process.env.MESSAGE_ENCRYPTION_KEY =
      'new-message-key-for-production-rotation-32bytes';
    expect(decryptContent('legacy plaintext message')).toBe(
      'legacy plaintext message'
    );
  });

  it('refuses new production writes when the dedicated key is missing', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.MESSAGE_ENCRYPTION_KEY;
    expect(() => encryptContent('do not write with a development key')).toThrow(
      'MESSAGE_ENCRYPTION_KEY is required for production writes'
    );
  });
});
