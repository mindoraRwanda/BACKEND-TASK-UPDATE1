export const openApiSpec = {
  openapi: '3.0.0',
  info: {
    title: 'Mindora AI Integration Service API',
    version: '1.0.0',
    description:
      'AI chat companion for patients, with a keyword-based crisis pre-filter that runs ' +
      'on every message before it reaches (or bypasses) the AI provider. The AI provider ' +
      'is an external Therapy Chatbot API (own signup/login + conversation model) — ' +
      'ai-integration-service provisions one chatbot account per patient lazily, on that ' +
      "patient's first message (see `src/chatbotClient.ts`). GET /history and DELETE " +
      '/history are not implemented yet.\n\n' +
      '⚠️ The crisis keyword list has not been reviewed by a mental health professional — ' +
      'see `src/preFilter.ts` for the clinical-review note before relying on it in production.',
  },
  servers: [
    { url: 'http://localhost:3007', description: 'Local development (direct)' },
    {
      url: 'http://localhost:8000/api/v1/ai',
      description: 'Via Kong gateway (local)',
    },
    {
      url: 'https://api.mindora.rw/api/v1/ai',
      description: 'Via Kong gateway (production)',
    },
  ],
  tags: [{ name: 'Chat' }, { name: 'History' }, { name: 'Usage' }],
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
      ChatRequest: {
        type: 'object',
        required: ['message'],
        properties: {
          message: { type: 'string', minLength: 1 },
          sessionId: { type: 'string', nullable: true },
        },
      },
      CrisisChatResponse: {
        type: 'object',
        required: ['response', 'crisisLevel', 'sessionId'],
        properties: {
          response: {
            type: 'string',
            example:
              "I'm glad you told me. Your safety matters. If you may act on these thoughts or have already hurt yourself, contact local emergency services or go to the nearest emergency department now. For general MINDORA support during published hours (Monday–Friday, 9 AM–5 PM), call +250 783 974-066 or email info@mindora.rw; these are not emergency services.",
          },
          crisisLevel: { type: 'integer', enum: [3, 4, 5] },
          sessionId: { type: 'string', nullable: true, enum: [null] },
        },
      },
      ChatResponse: {
        type: 'object',
        required: ['response', 'crisisLevel', 'sessionId'],
        properties: {
          response: {
            type: 'string',
            description: "The AI provider's reply.",
          },
          crisisLevel: {
            type: 'integer',
            minimum: 0,
            maximum: 4,
            description:
              'Pre-filter level for this message (5 is handled separately — see CrisisChatResponse).',
          },
          sessionId: {
            type: 'string',
            nullable: true,
            description: 'Echoes the sessionId from the request, if provided.',
          },
        },
      },
      NotImplementedResponse: {
        type: 'object',
        required: ['message'],
        properties: {
          message: { type: 'string', example: 'Not implemented yet' },
          crisisLevel: {
            type: 'integer',
            minimum: 0,
            maximum: 4,
            description:
              'Present on POST /chat only, for levels below the immediate-escalation threshold.',
          },
        },
      },
      UsageResponse: {
        type: 'object',
        required: [
          'totalInteractions',
          'totalTokensUsed',
          'totalCrisisEvents',
          'avgResponseMs',
          'topUsers',
          'dailyBreakdown',
        ],
        properties: {
          totalInteractions: { type: 'integer' },
          totalTokensUsed: { type: 'integer' },
          totalCrisisEvents: {
            type: 'integer',
            description: 'Interactions where the pre-filter returned level 5.',
          },
          avgResponseMs: { type: 'integer' },
          topUsers: {
            type: 'array',
            description: 'Top 10 users by interaction volume, descending.',
            items: {
              type: 'object',
              properties: {
                userId: { type: 'string', format: 'uuid' },
                interactionCount: { type: 'integer' },
              },
            },
          },
          dailyBreakdown: {
            type: 'array',
            description: 'Last 30 days.',
            items: {
              type: 'object',
              properties: {
                date: { type: 'string', format: 'date' },
                count: { type: 'integer' },
              },
            },
          },
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
        description: 'Wrong role for this endpoint',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/ErrorMessage' },
          },
        },
      },
    },
  },
  paths: {
    '/health': {
      get: {
        tags: ['Chat'],
        summary: 'Service health check',
        description:
          'Note: this service applies JWT authentication globally, ahead of all routes ' +
          'including this one — a valid bearer token is required even for the health check.',
        security: [{ bearerAuth: [] }],
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
          '401': { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },
    '/chat': {
      post: {
        tags: ['Chat'],
        summary: 'Send a message to the AI (PATIENT only)',
        description:
          'Every message runs through a keyword-based crisis pre-filter before anything else, ' +
          'scored 0–5:\n\n' +
          '- **0** — no concerning language detected\n' +
          '- **1** — general distress (e.g. "sad", "anxious", "overwhelmed")\n' +
          '- **2** — passive hopelessness (e.g. "no reason to live", "what\'s the point")\n' +
          '- **3** — passive suicidal ideation (e.g. "I want to die", "life isn\'t worth living")\n' +
          '- **4** — active ideation without a stated plan (e.g. "I want to kill myself", "self harm")\n' +
          '- **5** — active plan or expressed intent (e.g. "I\'m going to kill myself", "I have a gun")\n\n' +
          '**Level 5 bypasses the AI entirely** — no AI provider call is made. The response is ' +
          'a fixed crisis-helpline message, a `mindora.ai` RabbitMQ event is published ' +
          'fire-and-forget (a broker outage must never block the safety message from reaching ' +
          'the user), and `sessionId` is always returned as `null`.\n\n' +
          'For levels 0–4, the message is forwarded to the external Therapy Chatbot API and its ' +
          'reply returned as `response`. Levels 3–4 escalation policy (therapist alerts, ' +
          'safety-check prompts) has not been clinically defined yet.',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ChatRequest' },
            },
          },
        },
        responses: {
          '200': {
            description:
              'Level 0–4: AI provider reply. Level 5: AI bypassed, helpline information ' +
              'returned instead.',
            content: {
              'application/json': {
                schema: {
                  oneOf: [
                    { $ref: '#/components/schemas/ChatResponse' },
                    { $ref: '#/components/schemas/CrisisChatResponse' },
                  ],
                },
              },
            },
          },
          '400': {
            description: 'message missing or empty',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorMessage' },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '502': {
            description:
              'The external Therapy Chatbot API was unreachable or errored',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorMessage' },
              },
            },
          },
        },
      },
    },
    '/history': {
      get: {
        tags: ['History'],
        summary: 'Get chat session history (PATIENT only)',
        description:
          'Not implemented yet — pending AI team chatbot integration.',
        security: [{ bearerAuth: [] }],
        responses: {
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '501': {
            description: 'Not implemented yet',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/NotImplementedResponse' },
              },
            },
          },
        },
      },
      delete: {
        tags: ['History'],
        summary: 'Delete all chat session history (PATIENT only)',
        description:
          'Not implemented yet — pending AI team chatbot integration.',
        security: [{ bearerAuth: [] }],
        responses: {
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '501': {
            description: 'Not implemented yet',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/NotImplementedResponse' },
              },
            },
          },
        },
      },
    },
    '/usage': {
      get: {
        tags: ['Usage'],
        summary: 'Aggregate AI usage report (ADMIN only)',
        description:
          'Total interactions, token usage, average response time, crisis-event count ' +
          '(level-5 pre-filter triggers), top 10 users by volume, and a 30-day daily breakdown.',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': {
            description: 'Usage report',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/UsageResponse' },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
    },
  },
};
