import express, {
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import helmet from 'helmet';
import { moodRouter } from './routes/mood.routes.js';
import { screeningRouter } from './routes/screening.routes.js';
import { registerOpenApiDocs } from './lib/openapi-docs.js';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const openApiPath = resolve(moduleDir, '../../../docs/mood-service.yaml');

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

  try {
    registerOpenApiDocs(app, openApiPath);
  } catch {
    // OpenAPI spec optional in test environments without the file path
  }

  app.use(moodRouter);
  app.use(screeningRouter);

  // Catches errors forwarded via next(err) — including rejected promises
  // from asyncHandler-wrapped routes — so a transient failure (e.g. a
  // dropped DB connection) returns a 500 instead of crashing the process.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
