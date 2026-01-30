import { createClient, RedisClientType } from 'redis';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { addTask, AddTaskInput } from './taskService.js';

const SUBSCRIBE_CHANNEL = 'copy-polymarket:tasks:incoming';
const NOTIFY_CHANNEL = 'copy-polymarket:notifications';

let subscriberClient: RedisClientType | null = null;
let publisherClient: RedisClientType | null = null;

interface IncomingMockTask {
  type: 'mock';
  address: string;
  profile: string;
  fixedAmount: number;
  initialAmount: number;
}

interface IncomingLiveTask {
  type: 'live';
  address: string;
  profile: string;
  fixAmount: number;
  privateKey: string;
  myWalletAddress: string;
}

type IncomingTask = IncomingMockTask | IncomingLiveTask;

function parseIncomingTask(data: IncomingTask): AddTaskInput {
  if (data.type === 'mock') {
    return {
      type: 'mock',
      address: data.address,
      url: data.profile,
      fixedAmount: data.fixedAmount,
      initialFinance: data.initialAmount,
      currentBalance: data.initialAmount,
    };
  }

  return {
    type: 'live',
    address: data.address,
    url: data.profile,
    fixedAmount: data.fixAmount,
    privateKey: data.privateKey,
    myWalletAddress: data.myWalletAddress,
  };
}

async function getPublisherClient(): Promise<RedisClientType> {
  if (publisherClient && publisherClient.isOpen) {
    return publisherClient;
  }

  publisherClient = createClient({ url: config.redis.url });

  publisherClient.on('error', (err: Error) => {
    logger.error({ err }, 'Redis publisher client error');
  });

  await publisherClient.connect();
  return publisherClient;
}

async function publishNotification(message: Record<string, unknown>): Promise<void> {
  const client = await getPublisherClient();
  await client.publish(NOTIFY_CHANNEL, JSON.stringify(message));
}

export async function startRedisSubscriber(): Promise<void> {
  subscriberClient = createClient({ url: config.redis.url });

  subscriberClient.on('error', (err: Error) => {
    logger.error({ err }, 'Redis subscriber client error');
  });

  await subscriberClient.connect();

  await subscriberClient.subscribe(SUBSCRIBE_CHANNEL, async (message) => {
    try {
      const data = JSON.parse(message) as IncomingTask;
      logger.info({ type: data.type, address: data.address }, 'Received task from Redis channel');

      const taskInput = parseIncomingTask(data);
      const task = await addTask(taskInput);

      logger.info({ taskId: task.id, type: task.type }, 'Task created from Redis subscription');

      await publishNotification({
        event: 'task_created',
        taskId: task.id,
        type: task.type,
        address: task.address,
        status: task.status,
      });
    } catch (err) {
      logger.error({ err, message }, 'Failed to process incoming task from Redis channel');

      await publishNotification({
        event: 'task_error',
        error: err instanceof Error ? err.message : 'Unknown error',
        rawMessage: message,
      }).catch((pubErr) => {
        logger.error({ err: pubErr }, 'Failed to publish error notification');
      });
    }
  });

  logger.info(`Subscribed to Redis channel: ${SUBSCRIBE_CHANNEL}`);
}

export async function stopRedisSubscriber(): Promise<void> {
  if (subscriberClient && subscriberClient.isOpen) {
    await subscriberClient.unsubscribe(SUBSCRIBE_CHANNEL);
    await subscriberClient.quit();
    subscriberClient = null;
  }

  if (publisherClient && publisherClient.isOpen) {
    await publisherClient.quit();
    publisherClient = null;
  }

  logger.info('Redis subscriber stopped');
}
