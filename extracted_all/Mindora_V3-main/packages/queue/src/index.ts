import amqp, {
  type Channel,
  type ChannelModel,
  type ConsumeMessage,
} from 'amqplib';

const DEFAULT_URL = 'amqp://mindora:mindora@localhost:5672';

export type MessageHandler = (
  content: unknown,
  raw: ConsumeMessage
) => Promise<void> | void;

type QueueConnection = Awaited<ReturnType<typeof amqp.connect>>;

let sharedConnection: QueueConnection | null = null;

export async function connect(
  url = process.env.RABBITMQ_URL ?? DEFAULT_URL
): Promise<ChannelModel> {
  if (sharedConnection) {
    return sharedConnection;
  }
  // Use a local variable so TypeScript knows the return value is never null,
  // even though the 'close' listener later resets sharedConnection to null.
  const connection = await amqp.connect(url);
  connection.on('close', () => {
    sharedConnection = null;
  });
  sharedConnection = connection;
  return connection;
}

export async function publish(
  queue: string,
  payload: unknown,
  url?: string
): Promise<void> {
  const connection = await connect(url);
  const channel = await connection.createChannel();
  await channel.assertQueue(queue, { durable: true });
  channel.sendToQueue(queue, Buffer.from(JSON.stringify(payload)), {
    persistent: true,
    contentType: 'application/json',
  });
  await channel.close();
}

/**
 * Publish a JSON payload to a topic exchange (used by appointment domain events).
 */
export async function publishToExchange(
  exchange: string,
  routingKey: string,
  payload: unknown,
  url?: string
): Promise<void> {
  const connection = await connect(url);
  const channel = await connection.createConfirmChannel();
  try {
    await channel.assertExchange(exchange, 'topic', { durable: true });
    let returnedMessage: string | null = null;
    // mandatory=true makes RabbitMQ return an event if no queue is bound to
    // this routing key. Publisher confirms alone do not detect unroutable
    // messages, which could otherwise make a password-reset request appear
    // accepted while no notification consumer can ever receive it.
    channel.on('return', (message) => {
      returnedMessage =
        message.fields.replyText || 'message was not routed to a queue';
    });
    channel.publish(
      exchange,
      routingKey,
      Buffer.from(JSON.stringify(payload)),
      {
        persistent: true,
        contentType: 'application/json',
        mandatory: true,
      }
    );
    await channel.waitForConfirms();
    if (returnedMessage) {
      throw new Error(
        `RabbitMQ did not route event to a queue: ${returnedMessage}`
      );
    }
  } finally {
    await channel.close();
  }
}

export async function subscribe(
  queue: string,
  handler: MessageHandler,
  url?: string
): Promise<Channel> {
  const connection = await connect(url);
  const channel = await connection.createChannel();
  await channel.assertQueue(queue, { durable: true });
  await channel.consume(queue, async (message: ConsumeMessage | null) => {
    if (!message) return;
    try {
      const content = JSON.parse(message.content.toString()) as unknown;
      await handler(content, message);
      channel.ack(message);
    } catch (error) {
      channel.nack(message, false, false);
      console.error(`Failed to process message on ${queue}:`, error);
    }
  });
  return channel;
}

export async function subscribeToExchange(
  exchange: string,
  queue: string,
  handler: MessageHandler,
  type: 'fanout' | 'topic' = 'fanout',
  url?: string
): Promise<void> {
  const connection = await connect(url);
  const channel = await connection.createChannel();
  await channel.assertExchange(exchange, type, { durable: true });
  await channel.assertQueue(queue, { durable: true });
  // Fanout ignores routing keys entirely, so an empty binding key receives
  // everything. For topic exchanges (used by publishToExchange callers),
  // '#' is the wildcard that matches every routing key — this package has
  // no per-routing-key filtering on the consume side, only exchange-wide
  // fan-in, so callers that need a topic exchange must declare it here too:
  // asserting the same exchange name with two different types (e.g. a
  // publisher using 'topic' while this asserts 'fanout') makes RabbitMQ
  // throw PRECONDITION_FAILED on whichever side connects second.
  await channel.bindQueue(queue, exchange, type === 'topic' ? '#' : '');
  await channel.consume(queue, async (message: ConsumeMessage | null) => {
    if (!message) return;
    try {
      const content = JSON.parse(message.content.toString()) as unknown;
      await handler(content, message);
      channel.ack(message);
    } catch (error) {
      channel.nack(message, false, false);
      console.error(
        `Failed to process message from exchange ${exchange}:`,
        error
      );
    }
  });
}

export async function disconnect(): Promise<void> {
  if (sharedConnection) {
    await sharedConnection.close();
    sharedConnection = null;
  }
}
