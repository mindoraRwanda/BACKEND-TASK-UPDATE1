import crypto from 'crypto';

const LEGACY_ENCRYPTION_KEY = Buffer.from(
  'mindora-dev-message-key-32bytes!!',
  'utf8'
).slice(0, 32);

function configuredEncryptionKey(): Buffer | null {
  const raw = process.env.MESSAGE_ENCRYPTION_KEY?.trim();
  if (!raw) return null;
  const key = Buffer.from(raw, 'utf8');
  if (key.length < 32) {
    throw new Error('MESSAGE_ENCRYPTION_KEY must be at least 32 bytes');
  }
  return key.slice(0, 32);
}

function encryptionKeyForWrite(): Buffer {
  const key = configuredEncryptionKey();
  if (!key && process.env.NODE_ENV === 'production') {
    throw new Error('MESSAGE_ENCRYPTION_KEY is required for production writes');
  }
  return key ?? LEGACY_ENCRYPTION_KEY;
}

function decryptWithKey(
  ivHex: string,
  authTagHex: string,
  encryptedHex: string,
  key: Buffer
): string {
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const encrypted = Buffer.from(encryptedHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(encrypted).toString('utf8') + decipher.final('utf8');
}

export function encryptContent(plaintext: string): string {
  const key = encryptionKeyForWrite();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptContent(ciphertext: string): string {
  const parts = ciphertext.split(':');
  if (parts.length !== 3) return ciphertext;
  const currentKey = configuredEncryptionKey();
  const keys = currentKey
    ? [currentKey, LEGACY_ENCRYPTION_KEY]
    : [LEGACY_ENCRYPTION_KEY];

  for (const key of keys) {
    try {
      return decryptWithKey(parts[0], parts[1], parts[2], key);
    } catch {
      // Older encrypted records may still use the previous default key.
    }
  }
  return ciphertext;
}
