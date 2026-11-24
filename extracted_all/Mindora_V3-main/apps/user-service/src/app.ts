import express, {
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import helmet from 'helmet';
import multer from 'multer';
import swaggerUi from 'swagger-ui-express';
import { userRouter } from './routes/user.routes.js';
import { therapistApplicationRouter } from './routes/therapist-application.routes.js';
import { clinicalWorkspaceRouter } from './routes/clinical-workspace.routes.js';
import { openApiSpec } from './docs/openapi.js';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const therapistPhotosDir = resolve(moduleDir, '../public/therapist-photos');

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

  // Public, unauthenticated — mounted before any other middleware. The JSON
  // route must come before the /docs mount below — swaggerUi.setup()'s
  // fallback renders the HTML shell for any sub-path under the mount that
  // isn't a static asset, so registering this after it would make it
  // unreachable.
  app.get('/docs/openapi.json', (_req, res) => {
    res.json(openApiSpec);
  });
  app.use(
    '/docs',
    swaggerUi.serve,
    swaggerUi.setup(openApiSpec, { customSiteTitle: 'User Service API Docs' })
  );

  // Therapist profile photos — public, unauthenticated (an <img> tag can't
  // send an Authorization header), mirrored at both the bare path (direct
  // dev access) and the full gateway path (matches Kong's strip_path: false
  // user-photos route, same pattern as /health).
  app.use('/photos', express.static(therapistPhotosDir));
  app.use('/api/v1/users/photos', express.static(therapistPhotosDir));

  app.use(express.json());
  // Mounted before userRouter: therapistApplicationRouter defines
  // GET /internal/users/therapist-applications, which would otherwise be
  // shadowed by userRouter's generic GET /internal/users/:id (same ordering
  // issue documented on /internal/users/analytics in user.routes.ts).
  app.use(therapistApplicationRouter);
  app.use('/api/v1/users', clinicalWorkspaceRouter);
  app.use(userRouter);

  // Multer (file upload) errors — bad mimetype from the fileFilter, or a
  // file over the 10MB limit — are client errors, not server errors; catch
  // them before the generic handler below so they return 400, not 500.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (
      err instanceof multer.MulterError ||
      (err instanceof Error && err.message === 'Unsupported file type')
    ) {
      res.status(400).json({ message: err.message });
      return;
    }
    next(err);
  });

  // Catches errors forwarded via next(err) — including rejected promises
  // from asyncHandler-wrapped routes — so a transient failure (e.g. a
  // dropped DB connection) returns a 500 instead of crashing the process.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ message: 'Internal server error' });
  });

  return app;
}
