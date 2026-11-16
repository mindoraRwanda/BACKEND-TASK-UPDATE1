import { beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import request from 'supertest';

vi.hoisted(() => {
  process.env.JWT_SECRET = 'mindora-dev-jwt-secret-change-in-production';
  process.env.JWT_ISSUER = 'mindora-auth';
  process.env.INTERNAL_SERVICE_TOKEN = 'test-internal-service-token';
  process.env.KONG_URL = 'http://kong.test';
  process.env.NODE_ENV = 'test';
});

vi.mock('ioredis', () => {
  const Redis = vi.fn(function () {
    return {
      status: 'ready' as const,
      connect: vi.fn().mockResolvedValue(undefined),
      exists: vi.fn().mockResolvedValue(0),
      set: vi.fn().mockResolvedValue('OK'),
      get: vi.fn().mockResolvedValue(null),
      del: vi.fn().mockResolvedValue(1),
      on: vi.fn(),
    };
  });
  return { default: Redis, Redis };
});

vi.mock('@mindora/http-client', () => ({
  httpClient: { get: vi.fn() },
  callService: vi.fn(),
  sanitizeForLog: (value: string) => value,
}));

const mockAuditCreate = vi.fn();
vi.mock('../lib/prisma.js', () => ({
  prisma: {
    audit_logs: {
      create: (...args: unknown[]) => mockAuditCreate(...args),
      findMany: vi.fn(),
      count: vi.fn(),
    },
    system_alerts: {},
    moderation_decisions: {},
  },
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', (...args: unknown[]) => mockFetch(...args));

import { createApp } from '../app.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(64, 1),
]);
const PDF = Buffer.from('%PDF-1.7\n%fake cv\n');

function tokenFor(role: string, sub = `${role}-1`) {
  return jwt.sign(
    { sub, email: `${role}@example.com`, role },
    process.env.JWT_SECRET!,
    { issuer: process.env.JWT_ISSUER, expiresIn: '15m' }
  );
}
const asAdmin = () => ({
  Authorization: `Bearer ${tokenFor('ADMIN', 'admin-1')}`,
});

const therapist = { userId: USER_ID, hasPhoto: true, hasCv: true };
function upstreamJson(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuditCreate.mockResolvedValue({ id: 'audit-1' });
  mockFetch.mockResolvedValue(upstreamJson({ therapist }));
});

describe('auth', () => {
  const routes: [string, string][] = [
    ['put', `/therapists/${USER_ID}/photo`],
    ['delete', `/therapists/${USER_ID}/photo`],
    ['put', `/therapists/${USER_ID}/cv`],
    ['get', `/therapists/${USER_ID}/cv`],
    ['delete', `/therapists/${USER_ID}/cv`],
    ['put', `/therapists/${USER_ID}/profile`],
    ['get', '/therapists'],
  ];

  it.each(routes)('401 unauthenticated: %s %s', async (method, path) => {
    const res = await (
      request(createApp()) as never as Record<
        string,
        (p: string) => request.Test
      >
    )[method]!(path);
    expect(res.status).toBe(401);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each(routes)('403 for a non-admin: %s %s', async (method, path) => {
    const res = await (
      request(createApp()) as never as Record<
        string,
        (p: string) => request.Test
      >
    )[method]!(path).set('Authorization', `Bearer ${tokenFor('PATIENT')}`);
    expect(res.status).toBe(403);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockAuditCreate).not.toHaveBeenCalled();
  });

  it('403 for a THERAPIST editing their own media through the admin route', async () => {
    const res = await request(createApp())
      .put(`/therapists/${USER_ID}/photo`)
      .set('Authorization', `Bearer ${tokenFor('THERAPIST')}`)
      .attach('file', JPEG, { filename: 'a.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(403);
  });
});

describe('PUT photo', () => {
  const put = (buf: Buffer, filename = 'p.jpg', contentType = 'image/jpeg') =>
    request(createApp())
      .put(`/therapists/${USER_ID}/photo`)
      .set(asAdmin())
      .attach('file', buf, { filename, contentType });

  it.each([
    ['GIF', Buffer.from('GIF89a' + 'x'.repeat(30)), 'a.gif', 'image/gif'],
    [
      'SVG',
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      'a.svg',
      'image/svg+xml',
    ],
    [
      'HEIC',
      Buffer.from('\0\0\0\x18ftypheic' + 'x'.repeat(20)),
      'a.heic',
      'image/heic',
    ],
    [
      'an .exe renamed to .jpg',
      Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200)]),
      'evil.jpg',
      'image/jpeg',
    ],
  ])(
    '415 for %s, listing the allowed types, nothing forwarded',
    async (_n, buf, name, type) => {
      const res = await put(buf, name, type);
      expect(res.status).toBe(415);
      expect(res.body.message).toMatch(/JPEG, PNG, WebP/);
      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockAuditCreate).not.toHaveBeenCalled();
    }
  );

  it('413 for a file over 5 MB', async () => {
    const res = await put(
      Buffer.concat([JPEG, Buffer.alloc(5 * 1024 * 1024, 1)])
    );
    expect(res.status).toBe(413);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('400 when no file part is sent', async () => {
    const res = await request(createApp())
      .put(`/therapists/${USER_ID}/photo`)
      .set(asAdmin())
      .field('note', 'x');
    expect(res.status).toBe(400);
  });

  it('400 for a non-UUID userId', async () => {
    const res = await request(createApp())
      .put('/therapists/not-a-uuid/photo')
      .set(asAdmin())
      .attach('file', JPEG, { filename: 'a.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(400);
  });

  it('forwards the bytes with the service token and writes an audit entry', async () => {
    const res = await put(JPEG);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ therapist, auditLogId: 'audit-1' });

    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe(
      `http://kong.test/internal/users/therapists/${USER_ID}/photo`
    );
    expect(init.method).toBe('PUT');
    expect(init.headers.Authorization).toBe(
      'Bearer test-internal-service-token'
    );
    expect(Buffer.from(init.body).equals(JPEG)).toBe(true);

    expect(mockAuditCreate).toHaveBeenCalledWith({
      data: {
        adminId: 'admin-1',
        actionType: 'THERAPIST_PHOTO_UPDATED',
        targetId: USER_ID,
        metadata: { imageType: 'jpeg', sizeBytes: JPEG.length },
      },
    });
  });

  it('passes a 404 through and writes NO audit entry', async () => {
    mockFetch.mockResolvedValue(
      upstreamJson({ message: 'Therapist not found' }, 404)
    );
    const res = await put(JPEG);
    expect(res.status).toBe(404);
    expect(res.body.message).toBe('Therapist not found');
    expect(mockAuditCreate).not.toHaveBeenCalled();
  });

  it('503 when User Service is unreachable, no audit entry', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await put(JPEG);
    expect(res.status).toBe(503);
    expect(mockAuditCreate).not.toHaveBeenCalled();
  });

  it('502 on an unexpected upstream status', async () => {
    mockFetch.mockResolvedValue(upstreamJson({ message: 'boom' }, 500));
    const res = await put(JPEG);
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain('boom');
  });
});

describe('DELETE photo / cv', () => {
  it('removes the photo and audits', async () => {
    const res = await request(createApp())
      .delete(`/therapists/${USER_ID}/photo`)
      .set(asAdmin());
    expect(res.status).toBe(200);
    expect(mockFetch.mock.calls[0]![1].method).toBe('DELETE');
    expect(mockAuditCreate.mock.calls[0]![0].data.actionType).toBe(
      'THERAPIST_PHOTO_REMOVED'
    );
  });

  it('removes the CV and audits', async () => {
    const res = await request(createApp())
      .delete(`/therapists/${USER_ID}/cv`)
      .set(asAdmin());
    expect(res.status).toBe(200);
    expect(mockAuditCreate.mock.calls[0]![0].data.actionType).toBe(
      'THERAPIST_CV_REMOVED'
    );
  });
});

describe('PUT cv', () => {
  const put = (
    buf: Buffer,
    filename = 'cv.pdf',
    contentType = 'application/pdf'
  ) =>
    request(createApp())
      .put(`/therapists/${USER_ID}/cv`)
      .set(asAdmin())
      .attach('file', buf, { filename, contentType });

  it('415 for a non-PDF even when labelled application/pdf', async () => {
    const res = await put(
      Buffer.from('MZ not a pdf'),
      'cv.pdf',
      'application/pdf'
    );
    expect(res.status).toBe(415);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('415 for a JPEG', async () => {
    expect((await put(JPEG, 'cv.jpg', 'image/jpeg')).status).toBe(415);
  });

  it('413 over 5 MB', async () => {
    const res = await put(
      Buffer.concat([PDF, Buffer.alloc(5 * 1024 * 1024, 1)])
    );
    expect(res.status).toBe(413);
  });

  it('forwards the PDF and audits with the file name and size', async () => {
    const res = await put(PDF, 'My CV.pdf');
    expect(res.status).toBe(200);
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe(
      `http://kong.test/internal/users/therapists/${USER_ID}/cv?fileName=My%20CV.pdf`
    );
    expect(init.headers['Content-Type']).toBe('application/pdf');
    expect(mockAuditCreate.mock.calls[0]![0].data).toMatchObject({
      actionType: 'THERAPIST_CV_UPLOADED',
      targetId: USER_ID,
      metadata: { fileName: 'My CV.pdf', sizeBytes: PDF.length },
    });
  });
});

describe('GET cv (admin download)', () => {
  it('returns the PDF as an attachment with nosniff and audits the access', async () => {
    mockFetch.mockResolvedValue(
      new Response(PDF, {
        status: 200,
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': 'attachment; filename="cv.pdf"',
        },
      })
    );
    const res = await request(createApp())
      .get(`/therapists/${USER_ID}/cv`)
      .set(asAdmin())
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="cv.pdf"'
    );
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect((res.body as Buffer).equals(PDF)).toBe(true);
    expect(mockAuditCreate.mock.calls[0]![0].data.actionType).toBe(
      'THERAPIST_CV_DOWNLOADED'
    );
  });

  it('404 when no CV exists, no audit entry', async () => {
    mockFetch.mockResolvedValue(
      upstreamJson({ message: 'No CV on file' }, 404)
    );
    const res = await request(createApp())
      .get(`/therapists/${USER_ID}/cv`)
      .set(asAdmin());
    expect(res.status).toBe(404);
    expect(mockAuditCreate).not.toHaveBeenCalled();
  });
});

describe('PUT profile', () => {
  const put = (body: object) =>
    request(createApp())
      .put(`/therapists/${USER_ID}/profile`)
      .set(asAdmin())
      .send(body);

  it('validates length limits (1500 / 2000) and requires a field', async () => {
    expect((await put({ cvSummary: 'a'.repeat(1501) })).status).toBe(400);
    expect((await put({ bio: 'a'.repeat(2001) })).status).toBe(400);
    expect((await put({})).status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('forwards JSON and audits field names and lengths, not the text', async () => {
    const res = await put({ cvSummary: 'Hello there', bio: 'Bio' });
    expect(res.status).toBe(200);
    expect(JSON.parse(mockFetch.mock.calls[0]![1].body)).toEqual({
      cvSummary: 'Hello there',
      bio: 'Bio',
    });
    const meta = mockAuditCreate.mock.calls[0]![0].data.metadata;
    expect(meta).toEqual({
      fields: ['cvSummary', 'bio'],
      cvSummaryLength: 11,
      bioLength: 3,
    });
    expect(JSON.stringify(meta)).not.toContain('Hello there');
  });
});

describe('GET /therapists (admin list)', () => {
  it('forwards the filters and returns User Service data', async () => {
    mockFetch.mockResolvedValue(
      upstreamJson({ therapists: [therapist], total: 1, page: 1, limit: 20 })
    );
    const res = await request(createApp())
      .get('/therapists?missing=cv&search=ann')
      .set(asAdmin());
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    const url = new URL(mockFetch.mock.calls[0]![0]);
    expect(url.pathname).toBe('/internal/users/therapists');
    expect(url.searchParams.get('missing')).toBe('cv');
    expect(url.searchParams.get('search')).toBe('ann');
    expect(url.searchParams.get('page')).toBe('1');
  });

  it('400 for an invalid missing filter', async () => {
    const res = await request(createApp())
      .get('/therapists?missing=bogus')
      .set(asAdmin());
    expect(res.status).toBe(400);
  });
});
