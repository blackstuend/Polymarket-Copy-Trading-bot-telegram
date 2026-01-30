import { createClient, RedisClientType } from 'redis';
import { ethers } from 'ethers';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { addTask, AddTaskInput } from './taskService.js';
import getMyBalance from '../utils/getMyBalance.js';

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

function validateIncomingTask(data: unknown): asserts data is IncomingTask {
  if (!data || typeof data !== 'object') {
    throw new Error('Invalid task data: expected an object');
  }
  const obj = data as Record<string, unknown>;
  const type = obj.type;
  if (type !== 'mock' && type !== 'live') {
    throw new Error(`Invalid task type: ${String(type)}`);
  }

  if (!obj.address || typeof obj.address !== 'string') {
    throw new Error('Missing or invalid address');
  }

  if (!obj.profile || typeof obj.profile !== 'string') {
    throw new Error('Missing or invalid profile');
  }

  if (type === 'mock') {
    const fixedAmount = obj.fixedAmount as number;
    const initialAmount = obj.initialAmount as number;
    if (typeof fixedAmount !== 'number' || !Number.isFinite(fixedAmount) || fixedAmount <= 0) {
      throw new Error(`Invalid fixedAmount: ${fixedAmount}`);
    }
    if (typeof initialAmount !== 'number' || !Number.isFinite(initialAmount) || initialAmount <= 0) {
      throw new Error(`Invalid initialAmount: ${initialAmount}`);
    }
  }

  if (type === 'live') {
    const fixAmount = obj.fixAmount as number;
    const privateKey = obj.privateKey as string;
    const myWalletAddress = obj.myWalletAddress as string;
    if (typeof fixAmount !== 'number' || !Number.isFinite(fixAmount) || fixAmount <= 0) {
      throw new Error(`Invalid fixAmount: ${fixAmount}`);
    }
    if (!privateKey || typeof privateKey !== 'string') {
      throw new Error('Missing or invalid privateKey');
    }
    if (!myWalletAddress || typeof myWalletAddress !== 'string') {
      throw new Error('Missing or invalid myWalletAddress');
    }

    // Verify privateKey derives the expected wallet address
    let derivedAddress: string;
    try {
      const wallet = new ethers.Wallet(privateKey);
      derivedAddress = wallet.address;
    } catch {
      throw new Error('Invalid privateKey: cannot create wallet');
    }

    if (derivedAddress.toLowerCase() !== myWalletAddress.toLowerCase()) {
      throw new Error(
        `privateKey does not match myWalletAddress: expected ${myWalletAddress}, got ${derivedAddress}`
      );
    }
  }
}

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
      const data: unknown = JSON.parse(message);
      logger.info('Received task from Redis channel');

      validateIncomingTask(data);

      // For live tasks, ensure wallet has at least 3x fixAmount in USDC
      if (data.type === 'live') {
        const balance = await getMyBalance(data.myWalletAddress);
        const minRequired = data.fixAmount * 3;
        if (balance < minRequired) {
          throw new Error(
            `Insufficient USDC balance: ${balance.toFixed(2)} < ${minRequired.toFixed(2)} (3x fixAmount). ` +
            `Please deposit at least $${minRequired.toFixed(2)} to proceed.`
          );
        }
        logger.info(
          `Live task balance check passed: $${balance.toFixed(2)} >= $${minRequired.toFixed(2)} (3x fixAmount)`
        );
      }

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
