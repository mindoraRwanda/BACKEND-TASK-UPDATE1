import express, {
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from './docs/swagger.js';
import { healthRouteLimiter } from './middleware/rate-limit.js';
import { notificationsRouter } from './routes/notifications.routes.js';
import { voiceWebhooksRouter } from './routes/voice.routes.js';

const SERVICE_NAME = 'notification-service';
const GATEWAY_HEALTH_PATH = '/api/v1/notifications/health';

// Extracted from index.ts so tests can build a real Express app (supertest
// against createApp()) without also running the RabbitMQ/Firebase/Resend/
// SMS startup side effects index.ts's main() does — same split every other
// service in this monorepo already uses.
export function createApp() {
  const app = express();
  // Trust exactly one hop (Kong) so req.ip / express-rate-limit read the
  // real client IP from X-Forwarded-For instead of Kong's own container IP.
  app.set('trust proxy', 1);
  // Helmet defaults, CSP included. swagger-ui-express loads its scripts from
  // files and only needs inline styles, both allowed by the default policy.
  // upgrade-insecure-requests is dropped so /docs still loads over plain HTTP
  // (local dev, internal container traffic).
  app.use(
    helmet({
      contentSecurityPolicy: { directives: { upgradeInsecureRequests: null } },
    })
  );
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
  app.get('/docs.json', (_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.send(swaggerSpec);
  });

  const healthResponse = () => ({
    status: 'ok',
    service: SERVICE_NAME,
  });

  /**
   * @swagger
   * /health:
   *   get:
   *     summary: Service health check
   *     tags: [Health]
   *     responses:
   *       200:
   *         description: Service is running.
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/HealthResponse'
   * /api/v1/notifications/health:
   *   get:
   *     summary: Service health check (gateway path)
   *     tags: [Health]
   *     responses:
   *       200:
   *         description: Service is running.
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/HealthResponse'
   */
  app.get('/health', (_req, res) => {
    res.status(200).json(healthResponse());
  });

  app.get(GATEWAY_HEALTH_PATH, healthRouteLimiter, (_req, res) => {
    res.status(200).json(healthResponse());
  });

  app.use(voiceWebhooksRouter);
  app.use(notificationsRouter);

  // Catches errors forwarded via next(err) — including rejected promises
  // from asyncHandler-wrapped routes — so a route failure (e.g. a DB error)
  // returns a 500 instead of crashing the whole process.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ message: 'Internal server error' });
  });

  return app;
}
