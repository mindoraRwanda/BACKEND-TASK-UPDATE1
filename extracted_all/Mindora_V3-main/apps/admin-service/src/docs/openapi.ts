export const openApiSpec = {
  openapi: '3.0.0',
  info: {
    title: 'Mindora Admin Service API',
    version: '1.0.0',
    description:
      'Platform administration — user management, moderation, analytics, alerts, and an ' +
      'immutable audit log. Every route documented with a 200 response below is fully ' +
      'implemented; `analytics` proxy is empty for a field only when its owning ' +
      'service could not be reached.',
  },
  servers: [
    { url: 'http://localhost:3009', description: 'Local development (direct)' },
    {
      url: 'http://localhost:8000/api/v1/admin',
      description: 'Via Kong gateway (local)',
    },
    {
      url: 'https://api.mindora.rw/api/v1/admin',
      description: 'Via Kong gateway (production)',
    },
  ],
  tags: [
    { name: 'Users' },
    { name: 'Therapist Media' },
    { name: 'Moderation' },
    { name: 'Analytics' },
    { name: 'Audit Log' },
    { name: 'Alerts' },
    { name: 'AI Usage' },
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
      },
    },
    schemas: {
      ErrorMessage: {
        type: 'object',
        required: ['message'],
        properties: { message: { type: 'string' } },
      },
      UserRecord: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          email: { type: 'string', format: 'email' },
          role: { type: 'string', enum: ['PATIENT', 'THERAPIST', 'ADMIN'] },
          isActive: { type: 'boolean' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      SuspendReactivateBody: {
        type: 'object',
        required: ['reason'],
        properties: {
          reason: { type: 'string', minLength: 1, maxLength: 500 },
        },
      },
      SuspendReactivateResponse: {
        type: 'object',
        properties: {
          message: { type: 'string' },
          userId: { type: 'string', format: 'uuid' },
          auditLogId: { type: 'string', format: 'uuid' },
        },
      },
      AuditLogEntry: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          adminId: { type: 'string', format: 'uuid' },
          actionType: { type: 'string', example: 'USER_SUSPENDED' },
          targetId: { type: 'string', nullable: true },
          metadata: {
            type: 'object',
            nullable: true,
            additionalProperties: true,
          },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
    },
    responses: {
      Unauthorized: {
        description: 'Missing or invalid JWT',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/ErrorMessage' },
            example: { message: 'Unauthorized' },
          },
        },
      },
      Forbidden: {
        description: 'Authenticated but not an ADMIN',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/ErrorMessage' },
            example: { error: 'Admin access required' },
          },
        },
      },
      NotImplemented: {
        description: 'Not implemented yet',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/ErrorMessage' },
            example: { message: 'Not implemented yet' },
          },
        },
      },
    },
  },
  paths: {
    '/health': {
      get: {
        tags: ['Users'],
        summary: 'Service health check',
        description: 'Public — no JWT required.',
        responses: {
          '200': {
            description: 'Service is healthy',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', example: 'ok' },
                    service: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/users': {
      get: {
        tags: ['Users'],
        summary: 'List platform users (ADMIN only)',
        description:
          'Proxies through User Service to Auth Service, the source of truth for the users table.',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            in: 'query',
            name: 'role',
            schema: { type: 'string', enum: ['PATIENT', 'THERAPIST', 'ADMIN'] },
          },
          { in: 'query', name: 'isActive', schema: { type: 'boolean' } },
          {
            in: 'query',
            name: 'page',
            schema: { type: 'integer', minimum: 1, default: 1 },
          },
          {
            in: 'query',
            name: 'limit',
            schema: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
          },
        ],
        responses: {
          '200': {
            description: 'Paginated user list.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    users: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/UserRecord' },
                    },
                    total: { type: 'integer' },
                    page: { type: 'integer' },
                    limit: { type: 'integer' },
                  },
                },
              },
            },
          },
          '400': {
            description: 'Invalid query parameters',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorMessage' },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '503': {
            description: 'User Service unavailable',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorMessage' },
              },
            },
          },
        },
      },
    },
    '/therapists': {
      get: {
        tags: ['Therapist Media'],
        summary: 'List therapists with photo/CV completeness (ADMIN only)',
        description:
          'Paginated. Each item has hasPhoto, hasCv and hasCvSummary. Filter with ?missing=photo|cv|summary and ?search= (name or email).',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'page',
            in: 'query',
            schema: { type: 'integer', minimum: 1, default: 1 },
          },
          {
            name: 'limit',
            in: 'query',
            schema: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
          },
          {
            name: 'search',
            in: 'query',
            schema: { type: 'string', maxLength: 100 },
          },
          {
            name: 'missing',
            in: 'query',
            schema: { type: 'string', enum: ['photo', 'cv', 'summary'] },
          },
        ],
        responses: {
          200: { description: '{ therapists: [...], total, page, limit }' },
          400: { description: 'Invalid query.' },
          401: { description: 'Missing or invalid token.' },
          403: { description: 'Caller is not an ADMIN.' },
        },
      },
    },
    '/therapists/{userId}/photo': {
      put: {
        tags: ['Therapist Media'],
        summary: 'Upload a therapist photo (ADMIN only)',
        description:
          'JPEG, PNG or WebP only, checked by file signature (not extension or Content-Type). Max 5 MB. Stored under a random filename; the previous generated file is deleted. ADMIN only. Every change writes an audit_logs entry, only after User Service confirms it.',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'userId',
            in: 'path',
            required: true,
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['file'],
                properties: {
                  file: {
                    type: 'string',
                    format: 'binary',
                    description: 'JPEG, PNG or WebP, max 5 MB',
                  },
                },
              },
            },
          },
        },
        responses: {
          200: { description: '{ therapist, auditLogId }' },
          400: {
            description:
              'Invalid request (bad userId, missing file, validation failed).',
          },
          401: { description: 'Missing or invalid token.' },
          403: { description: 'Caller is not an ADMIN.' },
          404: { description: 'Therapist not found.' },
          413: { description: 'File larger than 5 MB.' },
          415: {
            description:
              'Not JPEG/PNG/WebP. The message lists the allowed types.',
          },
        },
      },
      delete: {
        tags: ['Therapist Media'],
        summary: 'Remove a therapist photo (ADMIN only)',
        description:
          'ADMIN only. Every change writes an audit_logs entry, only after User Service confirms it.',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'userId',
            in: 'path',
            required: true,
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        responses: {
          200: { description: '{ therapist, auditLogId }' },
          400: {
            description:
              'Invalid request (bad userId, missing file, validation failed).',
          },
          401: { description: 'Missing or invalid token.' },
          403: { description: 'Caller is not an ADMIN.' },
          404: { description: 'Therapist not found.' },
        },
      },
    },
    '/therapists/{userId}/cv': {
      put: {
        tags: ['Therapist Media'],
        summary: 'Upload a therapist CV PDF (ADMIN only)',
        description:
          'PDF only (%PDF- signature), max 5 MB. Stored outside the public static folder; its path is never returned by any endpoint. ADMIN only. Every change writes an audit_logs entry, only after User Service confirms it.',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'userId',
            in: 'path',
            required: true,
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['file'],
                properties: {
                  file: {
                    type: 'string',
                    format: 'binary',
                    description: 'PDF, max 5 MB',
                  },
                },
              },
            },
          },
        },
        responses: {
          200: { description: '{ therapist, auditLogId }' },
          400: {
            description:
              'Invalid request (bad userId, missing file, validation failed).',
          },
          401: { description: 'Missing or invalid token.' },
          403: { description: 'Caller is not an ADMIN.' },
          404: { description: 'Therapist not found.' },
          413: { description: 'File larger than 5 MB.' },
          415: { description: 'Not a PDF.' },
        },
      },
      get: {
        tags: ['Therapist Media'],
        summary: 'Download a therapist CV (ADMIN only)',
        description:
          'Returned as application/pdf with Content-Disposition: attachment and X-Content-Type-Options: nosniff. Every download is audited (THERAPIST_CV_DOWNLOADED).',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'userId',
            in: 'path',
            required: true,
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        responses: {
          200: { description: 'The PDF file.' },
          400: {
            description:
              'Invalid request (bad userId, missing file, validation failed).',
          },
          401: { description: 'Missing or invalid token.' },
          403: { description: 'Caller is not an ADMIN.' },
          404: { description: 'Therapist not found.' },
        },
      },
      delete: {
        tags: ['Therapist Media'],
        summary: 'Remove a therapist CV (ADMIN only)',
        description:
          'ADMIN only. Every change writes an audit_logs entry, only after User Service confirms it.',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'userId',
            in: 'path',
            required: true,
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        responses: {
          200: { description: '{ therapist, auditLogId }' },
          400: {
            description:
              'Invalid request (bad userId, missing file, validation failed).',
          },
          401: { description: 'Missing or invalid token.' },
          403: { description: 'Caller is not an ADMIN.' },
          404: { description: 'Therapist not found.' },
        },
      },
    },
    '/therapists/{userId}/profile': {
      put: {
        tags: ['Therapist Media'],
        summary: 'Update a therapist short CV and bio (ADMIN only)',
        description:
          'At least one field. null clears it. The audit entry records field names and lengths, not the text. ADMIN only. Every change writes an audit_logs entry, only after User Service confirms it.',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'userId',
            in: 'path',
            required: true,
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  cvSummary: {
                    type: 'string',
                    nullable: true,
                    maxLength: 1500,
                  },
                  bio: { type: 'string', nullable: true, maxLength: 2000 },
                },
              },
            },
          },
        },
        responses: {
          200: { description: '{ therapist, auditLogId }' },
          400: {
            description:
              'Invalid request (bad userId, missing file, validation failed).',
          },
          401: { description: 'Missing or invalid token.' },
          403: { description: 'Caller is not an ADMIN.' },
          404: { description: 'Therapist not found.' },
        },
      },
    },
    '/users/{id}/suspend': {
      put: {
        tags: ['Users'],
        summary: 'Suspend a user account (ADMIN only)',
        description:
          'Blocks the account immediately — an already-issued, still-valid access token stops ' +
          "working on its very next request, not just at its natural expiry (see createVerifyJwt's " +
          'Redis suspension check). Refresh tokens are revoked too. Writes an audit_logs entry ' +
          '(actionType USER_SUSPENDED) only after the downstream suspend actually succeeds.',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            in: 'path',
            name: 'id',
            required: true,
            schema: { type: 'string' },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/SuspendReactivateBody' },
            },
          },
        },
        responses: {
          '200': {
            description: 'User suspended.',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/SuspendReactivateResponse',
                },
              },
            },
          },
          '400': {
            description: 'Missing/invalid reason',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorMessage' },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': {
            description: 'User not found',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorMessage' },
              },
            },
          },
          '503': {
            description: 'User Service unavailable',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorMessage' },
              },
            },
          },
        },
      },
    },
    '/users/{id}/reactivate': {
      put: {
        tags: ['Users'],
        summary: 'Reactivate a previously suspended user account (ADMIN only)',
        description:
          'Mirrors PUT /users/{id}/suspend exactly — clears the Redis suspension flag so the ' +
          'account can authenticate again, and writes an audit_logs entry (actionType ' +
          'USER_REACTIVATED). Does not restore any refresh tokens revoked at suspension time — ' +
          'the user logs in fresh.',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            in: 'path',
            name: 'id',
            required: true,
            schema: { type: 'string' },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/SuspendReactivateBody' },
            },
          },
        },
        responses: {
          '200': {
            description: 'User reactivated.',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/SuspendReactivateResponse',
                },
              },
            },
          },
          '400': {
            description: 'Missing/invalid reason',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorMessage' },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': {
            description: 'User not found',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorMessage' },
              },
            },
          },
          '503': {
            description: 'User Service unavailable',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorMessage' },
              },
            },
          },
        },
      },
    },
    '/moderation/queue': {
      get: {
        tags: ['Moderation'],
        summary: 'List pending moderation reports (ADMIN only)',
        description:
          "Proxies live to Community Service — reports are never mirrored into Admin Service's own database.",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            in: 'query',
            name: 'page',
            schema: { type: 'integer', minimum: 1, default: 1 },
          },
          {
            in: 'query',
            name: 'limit',
            schema: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
          },
        ],
        responses: {
          '200': {
            description: 'Paginated PENDING reports from Community Service.',
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '503': {
            description: 'Community Service unavailable',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorMessage' },
              },
            },
          },
        },
      },
    },
    '/moderation/{id}/resolve': {
      put: {
        tags: ['Moderation'],
        summary: 'Resolve a moderation report (ADMIN only)',
        description:
          "decision REMOVED maps to REVIEWED on Community Service's report (which has no REMOVED status) — " +
          "admin-service's own moderation_decisions row is the record of what was actually decided. " +
          'Writes both a moderation_decisions row and an audit_logs entry (actionType REPORT_RESOLVED), only ' +
          'after Community Service confirms the resolution succeeded.',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            in: 'path',
            name: 'id',
            required: true,
            schema: { type: 'string' },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['decision', 'reason'],
                properties: {
                  decision: { type: 'string', enum: ['REMOVED', 'DISMISSED'] },
                  reason: { type: 'string', minLength: 1, maxLength: 500 },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Report resolved.' },
          '400': {
            description: 'Invalid decision/reason',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorMessage' },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': {
            description: 'Report not found',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorMessage' },
              },
            },
          },
          '503': {
            description: 'Community Service unavailable',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorMessage' },
              },
            },
          },
        },
      },
    },
    '/moderation/decrypt/{postId}': {
      post: {
        tags: ['Moderation'],
        summary:
          "Decrypt an anonymous community post's author for review (ADMIN only)",
        description:
          "Writes an audit_logs entry (actionType POST_AUTHOR_DECRYPTED) only after a successful lookup — revealing an anonymous author's identity is sensitive enough to always leave a trail.",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            in: 'path',
            name: 'postId',
            required: true,
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': { description: 'The decrypted author userId.' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': {
            description: 'Post not found',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorMessage' },
              },
            },
          },
          '503': {
            description: 'Community Service unavailable',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorMessage' },
              },
            },
          },
        },
      },
    },
    '/analytics': {
      get: {
        tags: ['Analytics'],
        summary:
          'Platform-wide analytics, aggregated from every service (ADMIN only)',
        description:
          'Fires one request per dependent service in parallel — no request waits on another. ' +
          'A field is null if (and only if) that specific service was unreachable; the response ' +
          'is always 200. Community Service is not deployed in V1, so totalCommunityPosts is ' +
          'always null.',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': {
            description:
              'Aggregated platform analytics — any field may be null if that service was unreachable.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    totalUsers: { type: 'integer', nullable: true },
                    activeUsersLast30Days: { type: 'integer', nullable: true },
                    totalAppointments: { type: 'integer', nullable: true },
                    completedAppointments: { type: 'integer', nullable: true },
                    totalMoodEntries: { type: 'integer', nullable: true },
                    avgMoodScorePlatform: { type: 'number', nullable: true },
                    totalCommunityPosts: {
                      type: 'integer',
                      nullable: true,
                      description:
                        'Always null — Community Service not deployed in V1.',
                    },
                    totalAiInteractions: { type: 'integer', nullable: true },
                    totalCrisisEvents: { type: 'integer', nullable: true },
                  },
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
    },
    '/audit-log': {
      get: {
        tags: ['Audit Log'],
        summary: 'Read the immutable admin action audit log (ADMIN only)',
        description:
          'Read-only — there is intentionally no update or delete route for this resource.',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            in: 'query',
            name: 'adminId',
            schema: { type: 'string' },
            description: 'Filter to actions taken by this admin.',
          },
          {
            in: 'query',
            name: 'actionType',
            schema: { type: 'string' },
            example: 'USER_SUSPENDED',
          },
          {
            in: 'query',
            name: 'targetId',
            schema: { type: 'string' },
            description: 'Filter to actions targeting this resource id.',
          },
          {
            in: 'query',
            name: 'startDate',
            schema: { type: 'string', format: 'date-time' },
          },
          {
            in: 'query',
            name: 'endDate',
            schema: { type: 'string', format: 'date-time' },
          },
          {
            in: 'query',
            name: 'page',
            schema: { type: 'integer', minimum: 1, default: 1 },
          },
          {
            in: 'query',
            name: 'limit',
            schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          },
        ],
        responses: {
          '200': {
            description: 'Paginated audit log entries, newest first.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    auditLogs: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/AuditLogEntry' },
                    },
                    total: { type: 'integer' },
                    page: { type: 'integer' },
                    limit: { type: 'integer' },
                  },
                },
              },
            },
          },
          '400': {
            description: 'Invalid query parameters',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorMessage' },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
    },
    '/alerts': {
      get: {
        tags: ['Alerts'],
        summary:
          'List unresolved system alerts raised from ai.crisis / mood.concern events (ADMIN only)',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            in: 'query',
            name: 'page',
            schema: { type: 'integer', minimum: 1, default: 1 },
          },
          {
            in: 'query',
            name: 'limit',
            schema: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
          },
        ],
        responses: {
          '200': {
            description: 'Paginated unresolved alerts, newest first.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    alerts: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          id: { type: 'string', format: 'uuid' },
                          eventType: {
                            type: 'string',
                            enum: ['AI_CRISIS', 'MOOD_CONCERN'],
                          },
                          severity: {
                            type: 'string',
                            enum: ['HIGH', 'MEDIUM', 'LOW'],
                          },
                          payload: {
                            type: 'object',
                            additionalProperties: true,
                          },
                          resolved: { type: 'boolean' },
                          createdAt: { type: 'string', format: 'date-time' },
                        },
                      },
                    },
                    total: { type: 'integer' },
                    page: { type: 'integer' },
                    limit: { type: 'integer' },
                  },
                },
              },
            },
          },
          '400': {
            description: 'Invalid query parameters',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorMessage' },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
    },
    '/alerts/{id}/resolve': {
      put: {
        tags: ['Alerts'],
        summary: 'Mark a system alert as resolved (ADMIN only)',
        description:
          'Writes an audit_logs entry (actionType ALERT_RESOLVED). Alerts are never auto-resolved — this is always a manual admin action.',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            in: 'path',
            name: 'id',
            required: true,
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': { description: 'Alert resolved.' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': {
            description: 'Alert not found',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorMessage' },
              },
            },
          },
        },
      },
    },
    '/ai/usage': {
      get: {
        tags: ['AI Usage'],
        summary: 'Proxy AI Integration Service usage report (ADMIN only)',
        description:
          "Forwards the caller's own JWT to AI Integration Service, not the internal service " +
          'token — /api/v1/ai/usage requires an ADMIN-role token specifically. Writes an ' +
          'audit_logs entry (actionType AI_USAGE_VIEWED) only after a successful proxied fetch.',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': {
            description:
              'AI usage report, passed through unchanged from AI Integration Service.',
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '503': {
            description: 'AI Service unavailable',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorMessage' },
              },
            },
          },
        },
      },
    },
  },
};
