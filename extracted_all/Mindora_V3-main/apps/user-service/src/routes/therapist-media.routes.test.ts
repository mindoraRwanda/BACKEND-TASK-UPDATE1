import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';

const { photosDir } = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindora-photos-'));
  process.env.JWT_SECRET = 'mindora-dev-jwt-secret-change-in-production';
  process.env.JWT_ISSUER = 'mindora-auth';
  process.env.NODE_ENV = 'test';
  process.env.PHOTOS_DIR = dir;
  process.env.PHOTOS_BASE_URL = 'http://gateway.test/api/v1/users/photos';
  return { photosDir: dir };
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

// In-memory therapist row that honours Prisma's `omit`, so the tests prove
// the routes really pass it (a fake that ignored `omit` would hide a leak).
type Row = Record<string, unknown>;
const USER_ID = '11111111-1111-4111-8111-111111111111';
let row: Row;

function applyOmit(r: Row, omit?: Record<string, boolean>): Row {
  if (!omit) return { ...r };
  return Object.fromEntries(Object.entries(r).filter(([k]) => !omit[k]));
}

const mockFindMany = vi.fn();
const mockCount = vi.fn();
vi.mock('../lib/prisma.js', () => ({
  prisma: {
    therapistProfile: {
      findUnique: vi.fn(
        async ({
          where,
          omit,
        }: {
          where: { userId: string };
          omit?: Record<string, boolean>;
        }) => (where.userId === row.userId ? applyOmit(row, omit) : null)
      ),
      update: vi.fn(async ({ data }: { data: Row }) => {
        row = { ...row, ...data };
        return { ...row };
      }),
      findMany: (...args: unknown[]) => mockFindMany(...args),
      count: (...args: unknown[]) => mockCount(...args),
    },
    patientProfile: { findUnique: vi.fn().mockResolvedValue(null) },
  },
}));

const mockUpload = vi.fn();
const mockDeleteDoc = vi.fn();
vi.mock('../lib/object-storage.js', () => ({
  buildDocumentStorageKey: vi.fn(),
  uploadDocument: (...args: unknown[]) => mockUpload(...args),
  deleteDocumentByKey: (...args: unknown[]) => mockDeleteDoc(...args),
  streamDocumentByKey: vi.fn(
    async (_key: string, res: { end: (b: Buffer) => void }) => {
      res.end(Buffer.from('%PDF-1.4 stored'));
    }
  ),
  getDocumentDownloadUrl: vi.fn(),
  InvalidDownloadTokenError: class extends Error {},
  streamDocumentForToken: vi.fn(),
}));

import { createApp } from '../app.js';

const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(64, 1),
]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 2),
]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0x24, 0, 0, 0]),
  Buffer.from('WEBP'),
  Buffer.alloc(32, 3),
]);
const PDF = Buffer.from('%PDF-1.7\n%fake cv\n');

function token(role: string) {
  return jwt.sign(
    { sub: `${role}-1`, email: 'x@mindora.internal', role },
    process.env.JWT_SECRET!,
    {
      expiresIn: '15m',
      issuer: process.env.JWT_ISSUER,
      jwtid: randomUUID(),
    }
  );
}
const auth = () => ({ Authorization: `Bearer ${token('SERVICE')}` });
const base = `/internal/users/therapists/${USER_ID}`;

beforeEach(() => {
  vi.clearAllMocks();
  mockUpload.mockResolvedValue(undefined);
  mockDeleteDoc.mockResolvedValue(undefined);
  row = {
    id: 'p1',
    userId: USER_ID,
    userName: 'Fictional Therapist',
    email: 'fictional@example.test',
    bio: 'Bio',
    photoUrl: null,
    cvSummary: 'Short CV',
    cvStorageKey: null,
    cvFileName: null,
    cvSizeBytes: null,
    applicationStatus: 'APPROVED',
    isSuspended: false,
    isAcceptingPatients: true,
  };
});

afterAll(() => rmSync(photosDir, { recursive: true, force: true }));

describe('auth gate', () => {
  it('401 without a token', async () => {
    const res = await request(createApp()).put(`${base}/photo`).send(JPEG);
    expect(res.status).toBe(401);
  });

  it('403 for a non-SERVICE token', async () => {
    const res = await request(createApp())
      .put(`${base}/photo`)
      .set('Authorization', `Bearer ${token('ADMIN')}`)
      .set('Content-Type', 'application/octet-stream')
      .send(JPEG);
    expect(res.status).toBe(403);
  });
});

describe('PUT photo', () => {
  const put = (body: Buffer, type = 'application/octet-stream') =>
    request(createApp())
      .put(`${base}/photo`)
      .set(auth())
      .set('Content-Type', type)
      .send(body);

  it.each([
    ['jpeg', JPEG, '.jpg'],
    ['png', PNG, '.png'],
    ['webp', WEBP, '.webp'],
  ])(
    'accepts a real %s and stores it under a random name',
    async (_n, buf, ext) => {
      const res = await put(buf);
      expect(res.status).toBe(200);
      const url = res.body.therapist.photoUrl as string;
      expect(url).toMatch(
        new RegExp(
          `^http://gateway\\.test/api/v1/users/photos/[a-f0-9]{32}\\${ext}$`
        )
      );
      expect(existsSync(join(photosDir, url.split('/').pop()!))).toBe(true);
      expect(res.body.therapist.hasPhoto).toBe(true);
    }
  );

  it('rejects a GIF with 415 and lists the allowed types', async () => {
    const res = await put(Buffer.from('GIF89a' + 'x'.repeat(20)), 'image/jpeg');
    expect(res.status).toBe(415);
    expect(res.body.message).toMatch(/JPEG, PNG, WebP/);
  });

  it('rejects an SVG with 415', async () => {
    const res = await put(
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
      'image/svg+xml'
    );
    expect(res.status).toBe(415);
  });

  it('rejects a Windows executable sent as image/jpeg', async () => {
    const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 0)]);
    const res = await put(exe, 'image/jpeg');
    expect(res.status).toBe(415);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('rejects a body over 5 MB with 413', async () => {
    const big = Buffer.concat([JPEG, Buffer.alloc(5 * 1024 * 1024, 1)]);
    const res = await put(big);
    expect(res.status).toBe(413);
  });

  it('400 on an empty body', async () => {
    const res = await request(createApp())
      .put(`${base}/photo`)
      .set(auth())
      .send();
    expect(res.status).toBe(400);
  });

  it('removes the previous generated photo but never a shared seed photo', async () => {
    const oldName = 'a'.repeat(32) + '.jpg';
    writeFileSync(join(photosDir, oldName), JPEG);
    row.photoUrl = `http://gateway.test/api/v1/users/photos/${oldName}`;
    const first = await put(PNG);
    expect(first.status).toBe(200);
    expect(existsSync(join(photosDir, oldName))).toBe(false);

    writeFileSync(join(photosDir, 'm1.jpg'), JPEG);
    row.photoUrl = 'http://gateway.test/api/v1/users/photos/m1.jpg';
    const second = await put(WEBP);
    expect(second.status).toBe(200);
    expect(existsSync(join(photosDir, 'm1.jpg'))).toBe(true);
  });

  it('404 for an unknown therapist', async () => {
    const res = await request(createApp())
      .put(
        '/internal/users/therapists/22222222-2222-4222-8222-222222222222/photo'
      )
      .set(auth())
      .set('Content-Type', 'application/octet-stream')
      .send(JPEG);
    expect(res.status).toBe(404);
  });
});

describe('DELETE photo', () => {
  it('clears photoUrl and removes the file', async () => {
    const name = 'b'.repeat(32) + '.png';
    writeFileSync(join(photosDir, name), PNG);
    row.photoUrl = `http://gateway.test/api/v1/users/photos/${name}`;
    const res = await request(createApp()).delete(`${base}/photo`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.therapist.hasPhoto).toBe(false);
    expect(existsSync(join(photosDir, name))).toBe(false);
  });
});

describe('CV file', () => {
  const putCv = (body: Buffer, qs = '') =>
    request(createApp())
      .put(`${base}/cv${qs}`)
      .set(auth())
      .set('Content-Type', 'application/pdf')
      .send(body);

  it('rejects a non-PDF (even if labelled application/pdf) with 415', async () => {
    const res = await putCv(Buffer.from('MZ not a pdf'));
    expect(res.status).toBe(415);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('rejects over 5 MB with 413', async () => {
    const res = await putCv(
      Buffer.concat([PDF, Buffer.alloc(5 * 1024 * 1024, 1)])
    );
    expect(res.status).toBe(413);
  });

  it('stores a PDF in GridFS and never returns the storage key', async () => {
    const res = await putCv(PDF, '?fileName=..%2F..%2FMy%20CV.pdf');
    expect(res.status).toBe(200);
    expect(mockUpload).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`^therapist-cvs/${USER_ID}/.+\\.pdf$`)),
      expect.any(Buffer),
      'application/pdf'
    );
    expect(res.body.therapist.hasCv).toBe(true);
    expect(res.body.therapist.cvFileName).toBe('My CV.pdf');
    expect(JSON.stringify(res.body)).not.toContain('therapist-cvs/');
    expect(JSON.stringify(res.body)).not.toContain('cvStorageKey');
  });

  it('replacing deletes the previous stored file', async () => {
    row.cvStorageKey = 'therapist-cvs/old/key.pdf';
    await putCv(PDF);
    expect(mockDeleteDoc).toHaveBeenCalledWith('therapist-cvs/old/key.pdf');
  });

  it('GET returns the PDF with attachment + nosniff headers', async () => {
    row.cvStorageKey = 'therapist-cvs/k.pdf';
    row.cvFileName = 'cv.pdf';
    const res = await request(createApp()).get(`${base}/cv`).set(auth());
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="cv.pdf"'
    );
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('GET 404 when there is no CV', async () => {
    const res = await request(createApp()).get(`${base}/cv`).set(auth());
    expect(res.status).toBe(404);
  });

  it('DELETE clears the fields and removes the stored file', async () => {
    row.cvStorageKey = 'therapist-cvs/k.pdf';
    const res = await request(createApp()).delete(`${base}/cv`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.therapist.hasCv).toBe(false);
    expect(mockDeleteDoc).toHaveBeenCalledWith('therapist-cvs/k.pdf');
  });
});

describe('PUT profile (cvSummary, bio)', () => {
  const put = (body: unknown) =>
    request(createApp())
      .put(`${base}/profile`)
      .set(auth())
      .send(body as object);

  it('updates both fields', async () => {
    const res = await put({ cvSummary: 'New summary', bio: 'New bio' });
    expect(res.status).toBe(200);
    expect(res.body.therapist.cvSummary).toBe('New summary');
    expect(res.body.therapist.hasCvSummary).toBe(true);
  });

  it('accepts exactly 1500 chars and rejects 1501', async () => {
    expect((await put({ cvSummary: 'a'.repeat(1500) })).status).toBe(200);
    expect((await put({ cvSummary: 'a'.repeat(1501) })).status).toBe(400);
  });

  it('rejects a bio over 2000 chars and an empty body', async () => {
    expect((await put({ bio: 'a'.repeat(2001) })).status).toBe(400);
    expect((await put({})).status).toBe(400);
  });

  it('null clears the summary', async () => {
    const res = await put({ cvSummary: null });
    expect(res.status).toBe(200);
    expect(res.body.therapist.hasCvSummary).toBe(false);
  });
});

describe('GET admin therapist list', () => {
  beforeEach(() => {
    mockFindMany.mockResolvedValue([row]);
    mockCount.mockResolvedValue(1);
  });

  it('returns summaries without any storage key', async () => {
    row.cvStorageKey = 'therapist-cvs/secret.pdf';
    const res = await request(createApp())
      .get('/internal/users/therapists?page=1&limit=20')
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.therapists[0]).toMatchObject({
      userId: USER_ID,
      name: 'Fictional Therapist',
      hasPhoto: false,
      hasCv: true,
      hasCvSummary: true,
    });
    expect(JSON.stringify(res.body)).not.toContain('secret.pdf');
  });

  it.each([
    ['photo', 'photoUrl'],
    ['cv', 'cvStorageKey'],
    ['summary', 'cvSummary'],
  ])('?missing=%s filters on %s', async (missing, field) => {
    await request(createApp())
      .get(`/internal/users/therapists?missing=${missing}`)
      .set(auth());
    expect(JSON.stringify(mockFindMany.mock.calls[0]![0].where)).toContain(
      field
    );
  });

  it('400 on an invalid missing value', async () => {
    const res = await request(createApp())
      .get('/internal/users/therapists?missing=bogus')
      .set(auth());
    expect(res.status).toBe(400);
  });
});

describe('public / self responses never expose CV file data', () => {
  it('GET /therapists omits the private fields but keeps cvSummary', async () => {
    row.cvStorageKey = 'therapist-cvs/secret.pdf';
    row.cvFileName = 'secret.pdf';
    mockFindMany.mockImplementation(
      async (args: { omit?: Record<string, boolean> }) => [
        applyOmit(row, args.omit),
      ]
    );
    mockCount.mockResolvedValue(1);
    const res = await request(createApp())
      .get('/therapists')
      .set('Authorization', `Bearer ${token('PATIENT')}`);
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('secret.pdf');
    expect(body).not.toContain('cvStorageKey');
    expect(res.body.therapists[0].cvSummary).toBe('Short CV');
  });

  it('GET /me (therapist) omits the private fields', async () => {
    row.cvStorageKey = 'therapist-cvs/secret.pdf';
    const res = await request(createApp())
      .get('/me')
      .set(
        'Authorization',
        `Bearer ${jwt.sign(
          { sub: USER_ID, email: 'a@b.test', role: 'THERAPIST' },
          process.env.JWT_SECRET!,
          {
            expiresIn: '15m',
            issuer: process.env.JWT_ISSUER,
            jwtid: randomUUID(),
          }
        )}`
      );
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('secret.pdf');
  });
});
