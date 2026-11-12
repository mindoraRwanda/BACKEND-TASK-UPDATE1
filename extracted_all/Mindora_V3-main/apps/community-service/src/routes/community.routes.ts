import { Router, Request, Response } from 'express';
import {
  CreateGroupDto,
  CreatePostDto,
  CreateCommentDto,
} from '@mindora/validation';
import { authenticate, requireRole } from '@mindora/auth-middleware';
import type { AuthenticatedRequest } from '@mindora/auth-middleware';
import { CommunityGroup, Post, Comment } from '../models/index.js';
import type { IPost } from '../models/Post.js';
import mongoose from 'mongoose';
import { encryptUserId, decryptUserId } from '../utils/encryption.js';
import { Report } from '../models/index.js';
import { publish } from '@mindora/queue';
import { httpClient } from '@mindora/http-client';
import {
  authenticatedRouteLimiter,
  publicRouteLimiter,
} from '../middleware/rate-limit.js';
import { asyncHandler } from '../middleware/async-handler.js';

const router = Router();

// Mounted separately at the Express app root (not under /api/v1/community
// like `router` below) — Kong's community-internal route forwards
// /internal/community/... unchanged (strip_path: false), so these routes
// must live at that exact path, not nested under the public API's prefix.
export const internalRouter = Router();

const KONG_URL = process.env.KONG_URL ?? 'http://localhost:8000';

interface UserServiceUser {
  id: string;
  userName: string | null;
}

interface PostAuthor {
  userName: string | null;
  avatarUrl: string | null;
}

async function resolveAuthor(post: IPost): Promise<PostAuthor> {
  if (post.isAnonymous) {
    return { userName: null, avatarUrl: null };
  }

  try {
    const userId = decryptUserId(post.encryptedAuthorId);
    const response = await httpClient.get<UserServiceUser>(
      KONG_URL,
      `/internal/users/${encodeURIComponent(userId)}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.INTERNAL_SERVICE_TOKEN}`,
        },
      }
    );

    if (response.ok && response.data) {
      return { userName: response.data.userName ?? 'Unknown', avatarUrl: null };
    }
  } catch (error) {
    console.error('Author lookup failed:', error);
  }

  return { userName: 'Unknown', avatarUrl: null };
}

/**
 * @swagger
 * /api/v1/community/groups:
 *   post:
 *     summary: Create a new community group
 *     tags: [Community Groups]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, description, category]
 *             properties:
 *               name:
 *                 type: string
 *                 minLength: 3
 *                 maxLength: 100
 *                 example: Anxiety Support Circle
 *               description:
 *                 type: string
 *                 minLength: 10
 *                 maxLength: 500
 *                 example: A safe space for people managing anxiety in their daily lives
 *               category:
 *                 type: string
 *                 enum: [ANXIETY, DEPRESSION, GRIEF, RELATIONSHIPS, STRESS, ADDICTION, GENERAL]
 *               isAnonymous:
 *                 type: boolean
 *                 default: false
 *     responses:
 *       201:
 *         description: Group created successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/CommunityGroup'
 *       400:
 *         description: Validation failed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ValidationError'
 *       401:
 *         description: Unauthorized — missing or invalid token
 *       403:
 *         description: Forbidden — only ADMIN users may create community groups
 */
router.post(
  '/groups',
  authenticatedRouteLimiter,
  authenticate,
  requireRole('ADMIN'),
  asyncHandler(async (req: Request, res: Response) => {
    const result = CreateGroupDto.safeParse(req.body);

    if (!result.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: result.error.issues,
      });
    }

    const { name, description, category, isAnonymous } = result.data;

    try {
      const group = await CommunityGroup.create({
        name,
        description,
        category,
        isAnonymous,
        memberCount: 0,
      });

      return res.status(201).json(group);
    } catch (error: unknown) {
      const mongoError = error as { code?: number; message?: string };
      if (mongoError.code === 11000) {
        return res
          .status(409)
          .json({ error: 'A group with this name already exists' });
      }
      console.error('Create group error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  })
);

/**
 * @swagger
 * /api/v1/community/groups:
 *   get:
 *     summary: List all community groups
 *     tags: [Community Groups]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Page number
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *         description: Number of results per page (max 50)
 *     responses:
 *       200:
 *         description: Paginated list of groups
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 groups:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/CommunityGroup'
 *                 total:
 *                   type: number
 *                 page:
 *                   type: number
 *                 limit:
 *                   type: number
 */
router.get(
  '/groups',
  publicRouteLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(
      50,
      Math.max(1, parseInt(req.query.limit as string) || 10)
    );
    const skip = (page - 1) * limit;

    try {
      const [groups, total] = await Promise.all([
        CommunityGroup.find().sort({ createdAt: -1 }).skip(skip).limit(limit),
        CommunityGroup.countDocuments(),
      ]);

      return res.status(200).json({
        groups,
        total,
        page,
        limit,
      });
    } catch (error) {
      console.error('List groups error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  })
);

/**
 * @swagger
 * /api/v1/community/groups/{id}/posts:
 *   post:
 *     summary: Create a post in a community group
 *     tags: [Posts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: The community group ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [content]
 *             properties:
 *               content:
 *                 type: object
 *                 required: [type]
 *                 description: TipTap document JSON
 *                 properties:
 *                   type:
 *                     type: string
 *                     enum: [doc]
 *                   content:
 *                     type: array
 *                     items:
 *                       type: object
 *                 example:
 *                   type: doc
 *                   content:
 *                     - type: paragraph
 *                       content:
 *                         - type: text
 *                           text: Breathing exercises have helped me a lot.
 *               isAnonymous:
 *                 type: boolean
 *                 default: false
 *                 description: If true, author identity is encrypted and hidden from response
 *     responses:
 *       201:
 *         description: Post created successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Post'
 *       400:
 *         description: Validation failed or invalid group ID format
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Community group not found
 */
router.post(
  '/groups/:id/posts',
  authenticatedRouteLimiter,
  authenticate,
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id as string)) {
      return res.status(400).json({ error: 'Invalid group ID' });
    }

    const group = await CommunityGroup.findById(id);
    if (!group) {
      return res.status(404).json({ error: 'Community group not found' });
    }

    const result = CreatePostDto.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: result.error.issues,
      });
    }

    const { content, isAnonymous } = result.data;
    const userId = req.user?.userId;

    if (!userId) {
      return res.status(401).json({ error: 'User ID not found in token' });
    }

    const encryptedAuthorId = encryptUserId(userId);

    try {
      const newPost = await Post.create({
        communityId: group._id,
        encryptedAuthorId,
        content,
        isAnonymous,
      });

      const responsePost = {
        _id: newPost._id,
        communityId: newPost.communityId,
        content: newPost.content,
        isAnonymous: newPost.isAnonymous,
        reactions: newPost.reactions,
        commentCount: newPost.commentCount,
        createdAt: newPost.createdAt,
        author: isAnonymous ? null : { userId },
      };

      return res.status(201).json(responsePost);
    } catch (error) {
      console.error('Create post error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  })
);

/**
 * @swagger
 * /api/v1/community/groups/{id}/posts/{postId}/comments:
 *   post:
 *     summary: Comment on a post
 *     tags: [Comments]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: The community group ID
 *       - in: path
 *         name: postId
 *         required: true
 *         schema:
 *           type: string
 *         description: The post ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [content]
 *             properties:
 *               content:
 *                 type: object
 *                 description: TipTap document JSON
 *               isAnonymous:
 *                 type: boolean
 *                 default: false
 *     responses:
 *       201:
 *         description: Comment created. Post's commentCount is incremented atomically alongside creation.
 *       400:
 *         description: Validation failed or invalid ID format
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Post not found in the specified group
 */
router.post(
  '/groups/:id/posts/:postId/comments',
  authenticatedRouteLimiter,
  authenticate,
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const id = req.params.id as string;
    const postId = req.params.postId as string;

    if (
      !mongoose.Types.ObjectId.isValid(id) ||
      !mongoose.Types.ObjectId.isValid(postId)
    ) {
      return res.status(400).json({ error: 'Invalid ID format' });
    }

    const post = await Post.findOne({ _id: postId, communityId: id });
    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    const result = CreateCommentDto.safeParse(req.body);
    if (!result.success) {
      return res
        .status(400)
        .json({ error: 'Validation failed', details: result.error.issues });
    }

    const { content, isAnonymous } = result.data;
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'User ID not found in token' });
    }
    const encryptedAuthorId = encryptUserId(userId);

    try {
      // Create comment and increment commentCount atomically in parallel
      const results = await Promise.all([
        Comment.create({
          postId: post._id,
          communityId: id,
          encryptedAuthorId,
          content,
          isAnonymous,
        }),
        Post.findByIdAndUpdate(postId, { $inc: { commentCount: 1 } }),
      ]);

      const comment = results[0];

      return res.status(201).json({
        _id: comment._id,
        postId: comment.postId,
        content: comment.content,
        isAnonymous: comment.isAnonymous,
        author: isAnonymous ? null : { userId },
        createdAt: comment.createdAt,
      });
    } catch (error) {
      console.error('Create comment error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  })
);

/**
 * @swagger
 * /api/v1/community/groups/{id}/posts/{postId}/react:
 *   post:
 *     summary: React to a post
 *     description: >
 *       Every post starts with all three reaction types present at count 0; reacting
 *       atomically increments the matching type's counter. There is no per-user
 *       reaction tracking — this is a simple aggregate counter, not a toggle.
 *     tags: [Posts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: The community group ID (unused by this handler, but part of the path)
 *       - in: path
 *         name: postId
 *         required: true
 *         schema:
 *           type: string
 *         description: The post ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [reactionType]
 *             properties:
 *               reactionType:
 *                 type: string
 *                 enum: [LIKE, HEART, SUPPORT]
 *     responses:
 *       200:
 *         description: Updated reaction counts
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 reactions:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       type:
 *                         type: string
 *                         enum: [LIKE, HEART, SUPPORT]
 *                       count:
 *                         type: number
 *       400:
 *         description: Invalid post ID or reaction type not in [LIKE, HEART, SUPPORT]
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Post not found
 */
router.post(
  '/groups/:id/posts/:postId/react',
  authenticatedRouteLimiter,
  authenticate,
  asyncHandler(async (req: Request, res: Response) => {
    const postId = req.params.postId as string;

    if (!mongoose.Types.ObjectId.isValid(postId)) {
      return res.status(400).json({ error: 'Invalid post ID' });
    }

    const { reactionType } = req.body;

    if (!['LIKE', 'HEART', 'SUPPORT'].includes(reactionType)) {
      return res.status(400).json({
        error: 'Invalid reaction type. Must be LIKE, HEART, or SUPPORT',
      });
    }

    try {
      const post = await Post.findById(postId);
      if (!post) {
        return res.status(404).json({ error: 'Post not found' });
      }

      // Find the reaction and increment its count
      const reactionIndex = post.reactions.findIndex(
        (r) => r.type === reactionType
      );

      if (reactionIndex === -1) {
        return res
          .status(400)
          .json({ error: 'Reaction type not found on post' });
      }

      // Use $inc with a dynamic path to atomically increment the right reaction
      const updatePath = `reactions.${reactionIndex}.count`;
      const updatedPost = await Post.findByIdAndUpdate(
        postId,
        { $inc: { [updatePath]: 1 } },
        { new: true }
      );

      return res.status(200).json({
        reactions: updatedPost?.reactions,
      });
    } catch (error) {
      console.error('React to post error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  })
);

/**
 * @swagger
 * /api/v1/community/reports:
 *   post:
 *     summary: Report a post or comment
 *     description: >
 *       Saves the report and publishes a `community.reported` event to the
 *       `mindora.community` RabbitMQ exchange for moderation. The event publish is
 *       fire-and-forget — a RabbitMQ outage does not fail the request, since the
 *       report is already persisted.
 *     tags: [Moderation]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [contentId, contentType, reason]
 *             properties:
 *               contentId:
 *                 type: string
 *                 description: Post or comment ID being reported
 *               contentType:
 *                 type: string
 *                 enum: [POST, COMMENT]
 *               reason:
 *                 type: string
 *     responses:
 *       201:
 *         description: Report created (status defaults to PENDING)
 *       400:
 *         description: Missing fields, invalid contentType, or invalid contentId format
 *       401:
 *         description: Unauthorized
 */
router.post(
  '/reports',
  authenticatedRouteLimiter,
  authenticate,
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { contentId, contentType, reason } = req.body;

    if (!contentId || !contentType || !reason) {
      return res
        .status(400)
        .json({ error: 'contentId, contentType, and reason are required' });
    }

    if (!['POST', 'COMMENT'].includes(contentType)) {
      return res
        .status(400)
        .json({ error: 'contentType must be POST or COMMENT' });
    }

    if (!mongoose.Types.ObjectId.isValid(contentId)) {
      return res.status(400).json({ error: 'Invalid contentId format' });
    }

    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'User ID not found in token' });
    }

    try {
      const report = await Report.create({
        contentId,
        contentType,
        reportedBy: userId,
        reason,
      });

      // Publish event to RabbitMQ — Admin Service will subscribe to this later
      try {
        await publish('mindora.community', {
          event: 'community.reported',
          reportId: report._id,
          contentId,
          contentType,
          reportedBy: userId,
          reason,
          reportedAt: report.createdAt,
        });
        console.log('Published community.reported event to RabbitMQ');
      } catch (queueError) {
        // Don't fail the request if RabbitMQ is down — report is already saved
        console.error('Failed to publish report event:', queueError);
      }

      return res.status(201).json({
        _id: report._id,
        contentId: report.contentId,
        contentType: report.contentType,
        reason: report.reason,
        status: report.status,
        createdAt: report.createdAt,
      });
    } catch (error) {
      console.error('Create report error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  })
);
/**
 * @swagger
 * /api/v1/community/groups/{id}/posts:
 *   get:
 *     summary: List posts in a community group
 *     description: >
 *       For non-anonymous posts, resolves the author's display name via an internal
 *       call to User Service (through Kong). Anonymous posts always return
 *       `userName: null`. Author resolution failures degrade to `userName: "Unknown"`
 *       rather than failing the request.
 *     tags: [Posts]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: The community group ID
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *           description: Max 50
 *     responses:
 *       200:
 *         description: Paginated list of posts
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 posts:
 *                   type: array
 *                   items:
 *                     allOf:
 *                       - $ref: '#/components/schemas/Post'
 *                       - type: object
 *                         properties:
 *                           userName:
 *                             type: string
 *                             nullable: true
 *                 total:
 *                   type: number
 *                 page:
 *                   type: number
 *                 limit:
 *                   type: number
 *       400:
 *         description: Invalid group ID
 */
router.get(
  '/groups/:id/posts',
  publicRouteLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const groupId = id as string;

    if (!mongoose.Types.ObjectId.isValid(groupId)) {
      return res.status(400).json({ error: 'Invalid group ID' });
    }

    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(
      50,
      Math.max(1, parseInt(req.query.limit as string) || 10)
    );
    const skip = (page - 1) * limit;

    try {
      const [posts, total] = await Promise.all([
        Post.find({ communityId: id })
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit),
        Post.countDocuments({ communityId: id }),
      ]);

      const enrichedPosts = await Promise.all(
        posts.map(async (post) => {
          const author = await resolveAuthor(post);
          return {
            _id: post._id,
            communityId: post.communityId,
            content: post.content,
            isAnonymous: post.isAnonymous,
            reactions: post.reactions,
            commentCount: post.commentCount,
            createdAt: post.createdAt,
            userName: author.userName,
            avatarUrl: author.avatarUrl,
          };
        })
      );

      return res.status(200).json({ posts: enrichedPosts, total, page, limit });
    } catch (error) {
      console.error('List posts error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  })
);

// INTERNAL SERVICE ENDPOINT — not exposed through the public Kong
// community-api route. Requires SERVICE role JWT in Authorization header.
// Backs Admin Service's moderation queue.
internalRouter.get(
  '/internal/community/reports',
  authenticatedRouteLimiter,
  authenticate,
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    if (req.user?.role !== 'SERVICE') {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Rebuilt from literals, not a type-cast pass-through of req.query.status
    // — a raw `as` cast performs no runtime check, so any string (or, via
    // Express's bracket-notation query parser, an object like
    // ?status[$ne]=PENDING) would have flowed straight into the Mongo query.
    const requestedStatus = req.query.status;
    let status: 'PENDING' | 'REVIEWED' | 'DISMISSED';
    if (requestedStatus === 'REVIEWED') {
      status = 'REVIEWED';
    } else if (requestedStatus === 'DISMISSED') {
      status = 'DISMISSED';
    } else {
      status = 'PENDING';
    }
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(
      50,
      Math.max(1, parseInt(req.query.limit as string) || 20)
    );
    const skip = (page - 1) * limit;

    try {
      const [reports, total] = await Promise.all([
        Report.find({ status }).sort({ createdAt: -1 }).skip(skip).limit(limit),
        Report.countDocuments({ status }),
      ]);

      return res.status(200).json({ reports, total, page, limit });
    } catch (error) {
      console.error('List reports error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  })
);

// INTERNAL SERVICE ENDPOINT — same SERVICE-role convention as above.
// Accepts community's own status vocabulary (REVIEWED/DISMISSED) — Admin
// Service maps its REMOVED/DISMISSED decision onto these before calling.
internalRouter.put(
  '/internal/community/reports/:id/resolve',
  authenticatedRouteLimiter,
  authenticate,
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    if (req.user?.role !== 'SERVICE') {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const id = req.params.id as string;
    const requestedStatus = (req.body as { status?: unknown })?.status;

    // Rebuilt from literals (see GET /internal/community/reports above for
    // why) — status only ever reaches the Mongo update as one of these two
    // hardcoded strings, never a pass-through of req.body.status itself.
    let status: 'REVIEWED' | 'DISMISSED';
    if (requestedStatus === 'REVIEWED') {
      status = 'REVIEWED';
    } else if (requestedStatus === 'DISMISSED') {
      status = 'DISMISSED';
    } else {
      return res
        .status(400)
        .json({ error: "status must be 'REVIEWED' or 'DISMISSED'" });
    }

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ error: 'Report not found' });
    }

    try {
      const report = await Report.findByIdAndUpdate(
        id,
        { status },
        { returnDocument: 'after' }
      );
      if (!report) {
        return res.status(404).json({ error: 'Report not found' });
      }

      return res.status(200).json({
        _id: report._id,
        contentId: report.contentId,
        contentType: report.contentType,
        reportedBy: report.reportedBy,
        reason: report.reason,
        status: report.status,
      });
    } catch (error) {
      console.error('Resolve report error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  })
);

// INTERNAL SERVICE ENDPOINT — same SERVICE-role convention as above.
// Reveals the real author behind an anonymous post for moderation review —
// works for both anonymous and non-anonymous posts (every post's author is
// encrypted at rest; isAnonymous only controls whether resolveAuthor()
// exposes it in normal display).
internalRouter.get(
  '/internal/community/posts/:postId/author',
  authenticatedRouteLimiter,
  authenticate,
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    if (req.user?.role !== 'SERVICE') {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const postId = req.params.postId as string;
    if (!mongoose.Types.ObjectId.isValid(postId)) {
      return res.status(404).json({ error: 'Post not found' });
    }

    try {
      const post = await Post.findById(postId);
      if (!post) {
        return res.status(404).json({ error: 'Post not found' });
      }

      const userId = decryptUserId(post.encryptedAuthorId);
      return res.status(200).json({ userId });
    } catch (error) {
      console.error('Decrypt post author error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  })
);

export default router;
