import crypto from 'crypto';

const LEGACY_ENCRYPTION_KEY = Buffer.from(
  'mindora-dev-community-key-32bytes!!',
  'utf8'
).slice(0, 32);

function configuredEncryptionKey(): Buffer | null {
  const raw = process.env.COMMUNITY_ENCRYPTION_KEY?.trim();
  if (!raw) return null;
  const key = Buffer.from(raw, 'utf8');
  if (key.length < 32) {
    throw new Error('COMMUNITY_ENCRYPTION_KEY must be at least 32 bytes');
  }
  return key.slice(0, 32);
}

function encryptionKeyForWrite(): Buffer {
  const key = configuredEncryptionKey();
  if (!key && process.env.NODE_ENV === 'production') {
    throw new Error(
      'COMMUNITY_ENCRYPTION_KEY is required for production writes'
    );
  }
  return key ?? LEGACY_ENCRYPTION_KEY;
}

function decryptWithKey(
  ivHex: string,
  authTagHex: string,
  dataHex: string,
  key: Buffer
): string {
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(ivHex, 'hex')
  );
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataHex, 'hex')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

export const encryptUserId = (userId: string): string => {
  const key = encryptionKeyForWrite();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(userId, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
};

export const decryptUserId = (encryptedAuthorId: string): string => {
  const [ivHex, authTagHex, dataHex] = encryptedAuthorId.split(':');
  if (!ivHex || !authTagHex || !dataHex) {
    throw new Error('Malformed encrypted author id');
  }

  const currentKey = configuredEncryptionKey();
  const keys = currentKey
    ? [currentKey, LEGACY_ENCRYPTION_KEY]
    : [LEGACY_ENCRYPTION_KEY];

  for (const key of keys) {
    try {
      return decryptWithKey(ivHex, authTagHex, dataHex, key);
    } catch {
      // Existing records may have been encrypted with the previous default key.
    }
  }

  throw new Error('Unable to decrypt community author id with available keys');
};
