import './env.js'; // must be first — loads .env before any module reads process.env
import { connect } from '@mindora/queue';
import { createApp } from './app.js';
import { startConsumers, SUBSCRIBED_EXCHANGES } from './consumers.js';
import { initFirebase } from './fcm.js';
import { initResend } from './email.js';
import { initSms } from './sms.js';
import { initVoice } from './voice.js';
import { setupRetryInfrastructure } from './retry.js';

const SERVICE_NAME = 'notification-service';
const PORT = Number(process.env.PORT) || 3008;

async function main(): Promise<void> {
  initFirebase();
  initResend();
  initSms();
  initVoice();

  await connect();
  console.log('✓ RabbitMQ connection established');

  await setupRetryInfrastructure();
  console.log('✓ Retry infrastructure ready (DLQ: mindora.notifications.dlq)');

  await startConsumers();
  console.log('✓ Subscribed to exchanges:');
  SUBSCRIBED_EXCHANGES.forEach((exchange) => {
    console.log(`  · ${exchange}`);
  });

  const app = createApp();
  app.listen(PORT, () => {
    console.log(`${SERVICE_NAME} listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
