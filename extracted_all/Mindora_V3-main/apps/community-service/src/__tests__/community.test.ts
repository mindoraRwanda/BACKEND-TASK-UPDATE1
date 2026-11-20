import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import supertest from 'supertest';
import mongoose from 'mongoose';
import app from '../app.js';
import {
  CommunityGroup,
  CommunityMembership,
  Post,
  Report,
} from '../models/index.js';
import { encryptUserId } from '../utils/encryption.js';

const request = supertest(app);

// A real test token signed with the dev secret
// This matches the JWT_SECRET=mindora-dev-jwt-secret-change-in-production in .env
import jwt from 'jsonwebtoken';

const TEST_SECRET = 'mindora-dev-jwt-secret-change-in-production';

// PATIENT token — used for post/comment endpoints (no role restriction there)
const patientToken = jwt.sign(
  { sub: 'test-user-123', email: 'karimi@mindora.com', role: 'PATIENT' },
  TEST_SECRET,
  { expiresIn: '7d', issuer: 'mindora-auth', jwtid: 'test-jti-001' }
);

// THERAPIST token — used to verify 403 on group creation
const therapistToken = jwt.sign(
  {
    sub: 'test-therapist-456',
    email: 'therapist@mindora.com',
    role: 'THERAPIST',
  },
  TEST_SECRET,
  { expiresIn: '7d', issuer: 'mindora-auth', jwtid: 'test-jti-002' }
);

// ADMIN token — required to create community groups
const adminToken = jwt.sign(
  { sub: 'test-admin-789', email: 'admin@mindora.com', role: 'ADMIN' },
  TEST_SECRET,
  { expiresIn: '7d', issuer: 'mindora-auth', jwtid: 'test-jti-003' }
);

// SERVICE token — used for the /internal/community/* endpoints
const serviceToken = jwt.sign(
  { sub: 'admin-service', email: 'service@mindora.com', role: 'SERVICE' },
  TEST_SECRET,
  { expiresIn: '7d', issuer: 'mindora-auth', jwtid: 'test-jti-004' }
);

const authHeader = `Bearer ${patientToken}`;
const adminHeader = `Bearer ${adminToken}`;
const serviceHeader = `Bearer ${serviceToken}`;

// Connect to a separate test database before tests run
beforeAll(async () => {
  await mongoose.connect('mongodb://localhost:27017/mindora_community_test');
});

// Clean the database before each test so tests don't affect each other
beforeEach(async () => {
  await CommunityGroup.deleteMany({});
  await CommunityMembership.deleteMany({});
  await Post.deleteMany({});
  await Report.deleteMany({});
});

// Disconnect after all tests finish
afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

// ─── Create Group Tests ────────────────────────────────────────────────────

describe('POST /api/v1/community/groups', () => {
  it('allows ADMIN to create a group', async () => {
    const response = await request
      .post('/api/v1/community/groups')
      .set('Authorization', adminHeader)
      .send({
        name: 'Anxiety Support Circle',
        description:
          'A safe space for people managing anxiety in their daily lives',
        category: 'ANXIETY',
        isAnonymous: false,
      });

    expect(response.status).toBe(201);
    expect(response.body.name).toBe('Anxiety Support Circle');
    expect(response.body.category).toBe('ANXIETY');
    expect(response.body._id).toBeDefined();
    expect(response.body.memberCount).toBe(0);
  });

  it('returns 403 when a PATIENT tries to create a group', async () => {
    const response = await request
      .post('/api/v1/community/groups')
      .set('Authorization', `Bearer ${patientToken}`)
      .send({
        name: 'Anxiety Support Circle',
        description:
          'A safe space for people managing anxiety in their daily lives',
        category: 'ANXIETY',
        isAnonymous: false,
      });

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('Forbidden');
  });

  it('returns 403 when a THERAPIST tries to create a group', async () => {
    const response = await request
      .post('/api/v1/community/groups')
      .set('Authorization', `Bearer ${therapistToken}`)
      .send({
        name: 'Anxiety Support Circle',
        description:
          'A safe space for people managing anxiety in their daily lives',
        category: 'ANXIETY',
        isAnonymous: false,
      });

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('Forbidden');
  });

  it('returns 401 when no auth token is provided', async () => {
    const response = await request.post('/api/v1/community/groups').send({
      name: 'Test Group',
      description: 'A test group description that is long enough',
      category: 'STRESS',
      isAnonymous: false,
    });

    expect(response.status).toBe(401);
  });

  it('returns 400 when required fields are missing', async () => {
    const response = await request
      .post('/api/v1/community/groups')
      .set('Authorization', adminHeader)
      .send({
        name: 'Missing description and category',
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Validation failed');
  });

  it('returns 400 when name is too short', async () => {
    const response = await request
      .post('/api/v1/community/groups')
      .set('Authorization', adminHeader)
      .send({
        name: 'Hi',
        description:
          'A valid description that is long enough to pass validation',
        category: 'ANXIETY',
        isAnonymous: false,
      });

    expect(response.status).toBe(400);
  });
});

// ─── List Groups Tests ─────────────────────────────────────────────────────

describe('GET /api/v1/community/groups', () => {
  it('returns paginated list of groups', async () => {
    // Seed 3 groups directly into the test database
    await CommunityGroup.insertMany([
      {
        name: 'Group One',
        description: 'Description for group one that is long enough',
        category: 'ANXIETY',
        isAnonymous: false,
        memberCount: 0,
      },
      {
        name: 'Group Two',
        description: 'Description for group two that is long enough',
        category: 'GRIEF',
        isAnonymous: true,
        memberCount: 0,
      },
      {
        name: 'Group Three',
        description: 'Description for group three that is long enough',
        category: 'STRESS',
        isAnonymous: false,
        memberCount: 0,
      },
    ]);

    const response = await request.get('/api/v1/community/groups');

    expect(response.status).toBe(200);
    expect(response.body.groups).toHaveLength(3);
    expect(response.body.total).toBe(3);
    expect(response.body.page).toBe(1);
    expect(response.body.limit).toBe(10);
  });

  it('respects page and limit query params', async () => {
    await CommunityGroup.insertMany([
      {
        name: 'Group One',
        description: 'Description for group one that is long enough',
        category: 'ANXIETY',
        isAnonymous: false,
        memberCount: 0,
      },
      {
        name: 'Group Two',
        description: 'Description for group two that is long enough',
        category: 'GRIEF',
        isAnonymous: false,
        memberCount: 0,
      },
      {
        name: 'Group Three',
        description: 'Description for group three that is long enough',
        category: 'STRESS',
        isAnonymous: false,
        memberCount: 0,
      },
    ]);

    const response = await request.get(
      '/api/v1/community/groups?page=1&limit=2'
    );

    expect(response.status).toBe(200);
    expect(response.body.groups).toHaveLength(2);
    expect(response.body.total).toBe(3);
    expect(response.body.page).toBe(1);
    expect(response.body.limit).toBe(2);
  });

  it('returns empty array when no groups exist', async () => {
    const response = await request.get('/api/v1/community/groups');

    expect(response.status).toBe(200);
    expect(response.body.groups).toHaveLength(0);
    expect(response.body.total).toBe(0);
  });
});

// ─── Community Membership Tests ───────────────────────────────────────────

describe('community membership', () => {
  it('joins once and increments memberCount only once', async () => {
    const group = await CommunityGroup.create({
      name: 'Peer Support Circle',
      description: 'A supportive community for shared learning',
      category: 'GENERAL',
      isAnonymous: false,
      memberCount: 0,
    });
    const groupPath = '/api/v1/community/groups/' + group._id + '/join';
    const first = await request
      .post(groupPath)
      .set('Authorization', authHeader);
    const second = await request
      .post(groupPath)
      .set('Authorization', authHeader);
    expect(first.status).toBe(200);
    expect(first.body.joined).toBe(true);
    expect(second.body.memberCount).toBe(1);
    expect(
      await CommunityMembership.countDocuments({ groupId: group._id })
    ).toBe(1);
    expect((await CommunityGroup.findById(group._id))?.memberCount).toBe(1);
  });

  it('leaves idempotently and decrements memberCount once', async () => {
    const group = await CommunityGroup.create({
      name: 'Stress Support Group',
      description: 'A supportive community for stress management',
      category: 'STRESS',
      isAnonymous: false,
      memberCount: 0,
    });
    const groupPath = '/api/v1/community/groups/' + group._id + '/join';
    await request.post(groupPath).set('Authorization', authHeader);
    const first = await request
      .delete(groupPath)
      .set('Authorization', authHeader);
    const second = await request
      .delete(groupPath)
      .set('Authorization', authHeader);
    expect(first.status).toBe(200);
    expect(first.body.joined).toBe(false);
    expect(second.body.memberCount).toBe(0);
    expect(
      await CommunityMembership.countDocuments({ groupId: group._id })
    ).toBe(0);
    expect((await CommunityGroup.findById(group._id))?.memberCount).toBe(0);
  });

  it('requires authentication and validates group ids', async () => {
    const unauthenticated = await request.post(
      '/api/v1/community/groups/invalid/join'
    );
    expect(unauthenticated.status).toBe(401);
    const invalidId = await request
      .post('/api/v1/community/groups/not-an-object-id/join')
      .set('Authorization', authHeader);
    expect(invalidId.status).toBe(400);
  });

  it('returns membership state for the authenticated user', async () => {
    const group = await CommunityGroup.create({
      name: 'Anxiety Support Group',
      description: 'A supportive community for anxiety management',
      category: 'ANXIETY',
      isAnonymous: false,
      memberCount: 0,
    });
    const response = await request
      .get('/api/v1/community/groups/' + group._id + '/membership')
      .set('Authorization', authHeader);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ joined: false, memberCount: 0 });
  });
});
// ─── Create Post Tests ─────────────────────────────────────────────────────

describe('POST /api/v1/community/groups/:id/posts', () => {
  const tipTapContent = (text: string) => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  });

  it('creates an anonymous post and hides author in response', async () => {
    const group = await CommunityGroup.create({
      name: 'Test Group',
      description: 'A test group description that is long enough to pass',
      category: 'ANXIETY',
      isAnonymous: true,
      memberCount: 0,
    });

    await CommunityMembership.create({
      groupId: group._id,
      userId: 'test-user-123',
    });

    const response = await request
      .post(`/api/v1/community/groups/${group._id}/posts`)
      .set('Authorization', authHeader)
      .send({
        content: tipTapContent(
          'I have been struggling and needed somewhere to share this.'
        ),
        isAnonymous: true,
      });

    expect(response.status).toBe(201);
    expect(response.body.isAnonymous).toBe(true);
    expect(response.body.author).toBeNull();
    expect(response.body.content.type).toBe('doc');
    // The raw userId must never appear in the response
    expect(JSON.stringify(response.body)).not.toContain('test-user-123');
  });

  it('creates a non-anonymous post and includes author in response', async () => {
    const group = await CommunityGroup.create({
      name: 'Test Group',
      description: 'A test group description that is long enough to pass',
      category: 'STRESS',
      isAnonymous: false,
      memberCount: 0,
    });

    await CommunityMembership.create({
      groupId: group._id,
      userId: 'test-user-123',
    });

    const response = await request
      .post(`/api/v1/community/groups/${group._id}/posts`)
      .set('Authorization', authHeader)
      .send({
        content: tipTapContent('Sharing openly because I am comfortable here.'),
        isAnonymous: false,
      });

    expect(response.status).toBe(201);
    expect(response.body.isAnonymous).toBe(false);
    expect(response.body.author).not.toBeNull();
    expect(response.body.author.userId).toBe('test-user-123');
    expect(response.body.content.type).toBe('doc');
  });

  it('rejects post creation by a user who has not joined the group', async () => {
    const group = await CommunityGroup.create({
      name: 'Member-only Group',
      description: 'A group requiring membership before posting',
      category: 'GENERAL',
      isAnonymous: false,
      memberCount: 0,
    });
    const response = await request
      .post(`/api/v1/community/groups/${group._id}/posts`)
      .set('Authorization', authHeader)
      .send({
        content: tipTapContent('This post should be rejected.'),
        isAnonymous: false,
      });
    expect(response.status).toBe(403);
    expect(response.body.error).toBe(
      'Join this community before creating a post'
    );
    expect(await Post.countDocuments({ communityId: group._id })).toBe(0);
  });

  it('returns 400 when content is a plain string instead of TipTap JSON', async () => {
    const group = await CommunityGroup.create({
      name: 'Test Group',
      description: 'A test group description that is long enough to pass',
      category: 'ANXIETY',
      isAnonymous: false,
      memberCount: 0,
    });

    const response = await request
      .post(`/api/v1/community/groups/${group._id}/posts`)
      .set('Authorization', authHeader)
      .send({ content: 'plain string', isAnonymous: false });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Validation failed');
  });

  it('returns 404 for a group that does not exist', async () => {
    const fakeId = new mongoose.Types.ObjectId();

    const response = await request
      .post(`/api/v1/community/groups/${fakeId}/posts`)
      .set('Authorization', authHeader)
      .send({
        content: tipTapContent('This should not work.'),
        isAnonymous: false,
      });

    expect(response.status).toBe(404);
  });

  it('returns 400 for invalid group ID format', async () => {
    const response = await request
      .post('/api/v1/community/groups/not-a-valid-id/posts')
      .set('Authorization', authHeader)
      .send({
        content: tipTapContent('This should not work either.'),
        isAnonymous: false,
      });

    expect(response.status).toBe(400);
  });
});

describe('GET /internal/community/reports', () => {
  it('lists PENDING reports by default, SERVICE role only', async () => {
    await Report.create({
      contentId: new mongoose.Types.ObjectId(),
      contentType: 'POST',
      reportedBy: 'test-user-123',
      reason: 'spam',
    });
    await Report.create({
      contentId: new mongoose.Types.ObjectId(),
      contentType: 'POST',
      reportedBy: 'test-user-123',
      reason: 'already handled',
      status: 'DISMISSED',
    });

    const response = await request
      .get('/internal/community/reports')
      .set('Authorization', serviceHeader);

    expect(response.status).toBe(200);
    expect(response.body.total).toBe(1);
    expect(response.body.reports[0].status).toBe('PENDING');
  });

  it('rejects a non-SERVICE (ADMIN) token with 403', async () => {
    const response = await request
      .get('/internal/community/reports')
      .set('Authorization', adminHeader);

    expect(response.status).toBe(403);
  });

  it('rejects no token with 401', async () => {
    const response = await request.get('/internal/community/reports');
    expect(response.status).toBe(401);
  });
});

describe('PUT /internal/community/reports/:id/resolve', () => {
  it('updates status to REVIEWED and returns contentId/contentType', async () => {
    const report = await Report.create({
      contentId: new mongoose.Types.ObjectId(),
      contentType: 'POST',
      reportedBy: 'test-user-123',
      reason: 'spam',
    });

    const response = await request
      .put(`/internal/community/reports/${report._id}/resolve`)
      .set('Authorization', serviceHeader)
      .send({ status: 'REVIEWED' });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('REVIEWED');
    expect(response.body.contentType).toBe('POST');

    const updated = await Report.findById(report._id);
    expect(updated?.status).toBe('REVIEWED');
  });

  it('returns 400 for an invalid status value', async () => {
    const report = await Report.create({
      contentId: new mongoose.Types.ObjectId(),
      contentType: 'POST',
      reportedBy: 'test-user-123',
      reason: 'spam',
    });

    const response = await request
      .put(`/internal/community/reports/${report._id}/resolve`)
      .set('Authorization', serviceHeader)
      .send({ status: 'REMOVED' }); // not a valid community status

    expect(response.status).toBe(400);
  });

  it('returns 404 for a report that does not exist', async () => {
    const fakeId = new mongoose.Types.ObjectId();
    const response = await request
      .put(`/internal/community/reports/${fakeId}/resolve`)
      .set('Authorization', serviceHeader)
      .send({ status: 'DISMISSED' });

    expect(response.status).toBe(404);
  });
});

describe('GET /internal/community/posts/:postId/author', () => {
  it('decrypts and returns the userId for an anonymous post', async () => {
    const group = await CommunityGroup.create({
      name: 'Test Group',
      description: 'A test group description that is long enough to pass',
      category: 'ANXIETY',
      isAnonymous: true,
      memberCount: 0,
    });
    const post = await Post.create({
      communityId: group._id,
      encryptedAuthorId: encryptUserId('test-user-123'),
      content: { type: 'doc', content: [] },
      isAnonymous: true,
    });

    const response = await request
      .get(`/internal/community/posts/${post._id}/author`)
      .set('Authorization', serviceHeader);

    expect(response.status).toBe(200);
    expect(response.body.userId).toBe('test-user-123');
  });

  it('returns 404 for a post that does not exist', async () => {
    const fakeId = new mongoose.Types.ObjectId();
    const response = await request
      .get(`/internal/community/posts/${fakeId}/author`)
      .set('Authorization', serviceHeader);

    expect(response.status).toBe(404);
  });

  it('rejects a non-SERVICE token with 403', async () => {
    const response = await request
      .get('/internal/community/posts/507f1f77bcf86cd799439011/author')
      .set('Authorization', authHeader);

    expect(response.status).toBe(403);
  });
});
