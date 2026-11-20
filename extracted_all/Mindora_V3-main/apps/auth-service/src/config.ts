function resolveAppBaseUrl(): string {
  const isProduction = process.env.NODE_ENV === 'production';
  const configured = process.env.APP_BASE_URL?.trim();
  const value =
    configured || (isProduction ? undefined : 'http://localhost:3000');
  if (!value) {
    throw new Error(
      'APP_BASE_URL must be configured in production for password reset links'
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('APP_BASE_URL must be a valid absolute URL');
  }

  if (
    isProduction &&
    (parsed.protocol !== 'https:' ||
      ['localhost', '127.0.0.1'].includes(parsed.hostname))
  ) {
    throw new Error('APP_BASE_URL must be a public HTTPS URL in production');
  }

  return value.replace(/\/$/, '');
}

function requireEnv(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT) || 3001,
  jwtSecret: requireEnv(
    'JWT_SECRET',
    'mindora-dev-jwt-secret-change-in-production'
  ),
  jwtIssuer: process.env.JWT_ISSUER ?? 'mindora-auth',
  accessTokenTtl: '15m' as const,
  refreshTokenDays: 7,
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  cookieName: 'refreshToken',
  // Set to the parent domain (e.g. .mindora.rw) when the frontend and this
  // API live on different subdomains. Without it the refresh cookie is
  // host-only on the API host, so the frontend's edge route guard (which
  // checks for this cookie on its own host) never sees a session and
  // bounces every successful login straight back to /login. Leave unset
  // for localhost, where cookies already ignore the port.
  cookieDomain: process.env.COOKIE_DOMAIN || undefined,
  isProduction: process.env.NODE_ENV === 'production',
  appBaseUrl: resolveAppBaseUrl(),
  // Where the browser lands after a successful Google OAuth callback. The
  // frontend route there does no token parsing — it just waits on its own
  // mount-time bootstrap (POST /refresh) to pick up the refreshToken cookie
  // this callback already set via issueAuthSession, same as a normal login.
  oauthSuccessRedirectUrl:
    process.env.OAUTH_SUCCESS_REDIRECT_URL ??
    'http://localhost:3000/oauth/success',
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID ?? '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
    callbackUrl:
      process.env.GOOGLE_CALLBACK_URL ??
      'http://localhost:3001/oauth/google/callback',
  },
};

export function isGoogleOAuthConfigured(): boolean {
  return Boolean(config.google.clientId && config.google.clientSecret);
}
