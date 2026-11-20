import swaggerJsdoc from 'swagger-jsdoc';

const eventArchitectureMarkdown = `
## Event-Driven Architecture

The Notification Service is a **RabbitMQ consumer** with no public HTTP API beyond health checks.
It subscribes to domain events and dispatches notifications through push (FCM), email (Resend), and SMS (Africa's Talking).

### Consumed Exchanges & Queues

| Exchange | Queue | Trigger | Channels |
|----------|-------|---------|----------|
| \`mindora.appointments\` | \`notification.appointments\` | Appointment booked | Push + Email + SMS to patient |
| \`mindora.appointments\` | \`notification.appointments\` | Appointment confirmed | Push + Email + SMS to patient |
| \`mindora.appointments\` | \`notification.appointments\` | Appointment cancelled | Push + Email + SMS to affected party |
| \`mindora.messages\` | \`notification.messages\` | Message received | Push preview to recipient |
| \`mindora.community\` | \`notification.community\` | Reply posted | Push to post author |
| \`mindora.mood\` | \`notification.mood\` | Mood logged | Logged only _(notification blocked — see TODOs)_ |
| \`mindora.ai\` | \`notification.ai\` | Crisis level detected | SMS to patient |

### Notification Channels

| Channel | Provider | Required Env Var(s) |
|---------|----------|---------------------|
| Push notification | Firebase Cloud Messaging | \`FIREBASE_SERVICE_ACCOUNT_JSON\` |
| Email | Resend | \`RESEND_EMAIL_API_KEY\` |
| SMS | Africa's Talking | \`AT_API_KEY\`, \`AT_USERNAME\` |

Each channel is optional — if its env var is absent, that channel is silently skipped.
User contact details (email, phone, FCM token) are fetched from the User Service at
\`GET /api/v1/users/:userId/preferences\` (\`USER_SERVICE_URL\` env var, default \`http://localhost:3002\`).

### Retry & Dead-Letter Queue

Failed deliveries are retried with exponential backoff via \`mindora.notifications.retry\`.
**Fatal errors** (invalid FCM token, blacklisted phone number, invalid sender ID) skip retries
and are routed directly to \`mindora.notifications.dlq\`.

### Event Schemas

**AppointmentBookedEvent** (\`mindora.appointments\`)
\`\`\`json
{
  "eventId": "uuid-v4",
  "occurredAt": "2025-01-15T09:00:00Z",
  "appointmentId": "appt-123",
  "patientId": "user-456",
  "therapistId": "user-789",
  "scheduledAt": "2025-01-20T14:00:00Z",
  "type": "INITIAL | FOLLOW_UP | EMERGENCY"
}
\`\`\`

**AppointmentConfirmedEvent** (\`mindora.appointments\`)
\`\`\`json
{
  "eventId": "uuid-v4",
  "occurredAt": "2025-01-15T09:30:00Z",
  "appointmentId": "appt-123",
  "patientId": "user-456",
  "therapistId": "user-789",
  "confirmedAt": "2025-01-15T09:30:00Z"
}
\`\`\`

**AppointmentCancelledEvent** (\`mindora.appointments\`)
\`\`\`json
{
  "eventId": "uuid-v4",
  "occurredAt": "2025-01-15T10:00:00Z",
  "appointmentId": "appt-123",
  "patientId": "user-456",
  "therapistId": "user-789",
  "cancelledBy": "PATIENT | THERAPIST",
  "reason": "optional cancellation reason"
}
\`\`\`

**MessageReceivedEvent** (\`mindora.messages\`)
\`\`\`json
{
  "eventId": "uuid-v4",
  "occurredAt": "2025-01-15T11:00:00Z",
  "messageId": "msg-abc",
  "conversationId": "conv-xyz",
  "senderId": "user-123",
  "recipientId": "user-456",
  "content": "Message preview text..."
}
\`\`\`

**CommunityReplyEvent** (\`mindora.community\`)
\`\`\`json
{
  "eventId": "uuid-v4",
  "occurredAt": "2025-01-15T12:00:00Z",
  "replyId": "reply-abc",
  "postAuthorId": "user-123",
  "excerpt": "Reply preview..."
}
\`\`\`

**AI Crisis Event** (\`mindora.ai\`)
\`\`\`json
{
  "eventId": "uuid-v4",
  "occurredAt": "2025-01-15T13:00:00Z",
  "userId": "user-456",
  "crisisLevel": 8
}
\`\`\`
`;

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Mindora Notification Service',
      version: '1.0.0',
      description:
        'Internal health endpoints for the Mindora Notification Service.\n\n' +
        'This service has **no public HTTP API** — it is a pure RabbitMQ consumer.\n\n' +
        eventArchitectureMarkdown,
    },
    servers: [
      { url: 'http://localhost:3008', description: 'Local development' },
      { url: 'http://localhost:8000', description: 'Via Kong Gateway (local)' },
      {
        url: 'https://api.mindora.rw',
        description: 'Via Kong Gateway (production)',
      },
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
        HealthResponse: {
          type: 'object',
          properties: {
            status: { type: 'string', example: 'ok' },
            service: { type: 'string', example: 'notification-service' },
          },
        },
        NotificationLog: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            userId: { type: 'string', format: 'uuid' },
            eventType: { type: 'string', example: 'appointment.booked' },
            channel: {
              type: 'string',
              enum: ['push', 'email', 'sms'],
              description:
                'SMS is currently disabled (SMS_ENABLED=false) pending V4 — sms-channel logs will show status "skipped" until then.',
            },
            status: {
              type: 'string',
              enum: ['delivered', 'failed', 'skipped'],
            },
            failureReason: { type: 'string', nullable: true },
            createdAt: {
              type: 'string',
              format: 'date-time',
              description: 'UTC.',
            },
            createdAtKigali: {
              type: 'string',
              description:
                'Same instant as createdAt, converted to Africa/Kigali (UTC+3) with the offset baked into the string.',
            },
            deliveredAt: {
              type: 'string',
              format: 'date-time',
              nullable: true,
            },
            deliveredAtKigali: { type: 'string', nullable: true },
          },
        },
      },
    },
  },
  apis: ['./src/index.ts', './src/routes/*.ts'],
};

export const swaggerSpec = swaggerJsdoc(options);
