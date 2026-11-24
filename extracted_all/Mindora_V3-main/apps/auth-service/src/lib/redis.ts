import { createHash } from 'node:crypto';
import {
  blacklistToken,
  getRedisClient,
  isTokenBlacklisted,
  passwordResetKey,
} from '@mindora/auth-middleware';
import { config } from '../config.js';

export { blacklistToken, isTokenBlacklisted, passwordResetKey };

const LOGIN_FAILURE_WINDOW_SECONDS = 15 * 60;
const LOGIN_LOCK_SECONDS = 15 * 60;
const emailKey = (email: string) =>
  createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
const loginFailuresKey = (email: string) =>
  `auth:login:failures:${emailKey(email)}`;
const loginLockedKey = (email: string) =>
  `auth:login:locked:${emailKey(email)}`;

export async function getLoginLockRemainingSeconds(
  email: string
): Promise<number> {
  const client = getRedisClient(config.redisUrl);
  const ttl = await client.ttl(loginLockedKey(email));
  return ttl > 0 ? ttl : 0;
}

export async function recordLoginFailure(
  email: string
): Promise<{ locked: boolean; lockedNow: boolean; retryAfterSeconds: number }> {
  const client = getRedisClient(config.redisUrl);
  const key = loginFailuresKey(email);
  const count = await client.incr(key);
  if (count === 1) await client.expire(key, LOGIN_FAILURE_WINDOW_SECONDS);
  if (count >= 5) {
    const lockedNow =
      (await client.set(
        loginLockedKey(email),
        '1',
        'EX',
        LOGIN_LOCK_SECONDS,
        'NX'
      )) === 'OK';
    await client.del(key);
    return { locked: true, lockedNow, retryAfterSeconds: LOGIN_LOCK_SECONDS };
  }
  return { locked: false, lockedNow: false, retryAfterSeconds: 0 };
}

export async function clearLoginFailures(email: string): Promise<void> {
  const client = getRedisClient(config.redisUrl);
  await client.del(loginFailuresKey(email));
}

export async function clearLoginLock(email: string): Promise<void> {
  const client = getRedisClient(config.redisUrl);
  await client.del(loginLockedKey(email), loginFailuresKey(email));
}

export async function connectRedis(): Promise<void> {
  const client = getRedisClient(config.redisUrl);
  if (client.status === 'ready') {
    return;
  }
  await client.connect();
  await client.ping();
}

export async function storePasswordResetToken(
  tokenHash: string,
  userId: string
): Promise<void> {
  const client = getRedisClient(config.redisUrl);
  await client.set(passwordResetKey(tokenHash), userId, 'EX', 15 * 60);
}

export async function getPasswordResetUserId(
  tokenHash: string
): Promise<string | null> {
  const client = getRedisClient(config.redisUrl);
  // Redis GETDEL consumes the one-time reset token atomically. Two concurrent
  // reset requests cannot both pass the token check.
  return client.getdel(passwordResetKey(tokenHash));
}

export async function deletePasswordResetToken(
  tokenHash: string
): Promise<void> {
  const client = getRedisClient(config.redisUrl);
  await client.del(passwordResetKey(tokenHash));
}
