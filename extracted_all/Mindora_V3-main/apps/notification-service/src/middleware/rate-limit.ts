import rateLimit from 'express-rate-limit';

const isTest = process.env.NODE_ENV === 'test';

export const healthRouteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: isTest ? 10_000 : 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests' },
});

export const authenticatedRouteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: isTest ? 10_000 : 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests' },
});

// Provider webhooks are externally reachable. Keep a separate limiter from
// authenticated user routes so a burst of callback traffic cannot consume
// the user's notification API budget. Express trusts one Kong proxy hop in
// app.ts, so req.ip resolves to the originating client/provider IP.
export const voiceWebhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: isTest ? 10_000 : 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many webhook requests' },
});
