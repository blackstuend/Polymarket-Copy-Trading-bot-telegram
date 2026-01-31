import { createClient, RedisClientType } from 'redis';
import { ethers } from 'ethers';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { addTask, AddTaskInput, stopTask, removeTask, getTask, updateTask } from './taskService.js';
import { scheduleTaskJob } from './queue.js';
import getMyBalance from '../utils/getMyBalance.js';
import { CopyTask } from '../types/task.js';

// ========================================
// Constants
// ========================================

const SUBSCRIBE_CHANNEL = 'copy-polymarket:tasks:incoming';
const NOTIFY_CHANNEL = 'copy-polymarket:notifications';

// ========================================
// Redis Clients
// ========================================

let subscriberClient: RedisClientType | null = null;
let publisherClient: RedisClientType | null = null;

// ========================================
// Types
// ========================================

/** Supported action types for incoming messages */
type ActionType = 'add' | 'stop' | 'remove' | 'restart';

interface BaseMessage {
  action: ActionType;
}

interface AddMockTaskMessage extends BaseMessage {
  action: 'add';
  type: 'mock';
  address: string;
  profile: string;
  fixedAmount: number;
  initialAmount: number;
}

interface AddLiveTaskMessage extends BaseMessage {
  action: 'add';
  type: 'live';
  address: string;
  profile: string;
  fixAmount: number;
  privateKey: string;
  myWalletAddress: string;
}

interface StopTaskMessage extends BaseMessage {
  action: 'stop';
  taskId: string;
}

interface RemoveTaskMessage extends BaseMessage {
  action: 'remove';
  taskId?: string; // If not provided, removes all tasks
}

interface RestartTaskMessage extends BaseMessage {
  action: 'restart';
  taskId: string;
}

type IncomingMessage =
  | AddMockTaskMessage
  | AddLiveTaskMessage
  | StopTaskMessage
  | RemoveTaskMessage
  | RestartTaskMessage;

// ========================================
// Validation Functions
// ========================================

function isValidAction(action: unknown): action is ActionType {
  return ['add', 'stop', 'remove', 'restart'].includes(action as string);
}

function validateBaseMessage(data: unknown): asserts data is BaseMessage {
  if (!data || typeof data !== 'object') {
    throw new Error('Invalid message: expected an object');
  }

  const obj = data as Record<string, unknown>;
  // Support legacy format without action (defaults to 'add')
  if (!obj.action) {
    obj.action = 'add';
  }

  if (!isValidAction(obj.action)) {
    throw new Error(`Invalid action: ${String(obj.action)}`);
  }
}

function validateAddTask(data: Record<string, unknown>): void {
  const type = data.type;
  if (type !== 'mock' && type !== 'live') {
    throw new Error(`Invalid task type: ${String(type)}`);
  }

  if (!data.address || typeof data.address !== 'string') {
    throw new Error('Missing or invalid address');
  }

  if (!data.profile || typeof data.profile !== 'string') {
    throw new Error('Missing or invalid profile');
  }

  if (type === 'mock') {
    const fixedAmount = data.fixedAmount as number;
    const initialAmount = data.initialAmount as number;
    if (typeof fixedAmount !== 'number' || !Number.isFinite(fixedAmount) || fixedAmount <= 0) {
      throw new Error(`Invalid fixedAmount: ${fixedAmount}`);
    }
    if (typeof initialAmount !== 'number' || !Number.isFinite(initialAmount) || initialAmount <= 0) {
      throw new Error(`Invalid initialAmount: ${initialAmount}`);
    }
  }

  if (type === 'live') {
    const fixAmount = data.fixAmount as number;
    const privateKey = data.privateKey as string;
    const myWalletAddress = data.myWalletAddress as string;

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

function validateTaskIdMessage(data: Record<string, unknown>, requireId: boolean = true): void {
  if (requireId && (!data.taskId || typeof data.taskId !== 'string')) {
    throw new Error('Missing or invalid taskId');
  }
  if (data.taskId && typeof data.taskId !== 'string') {
    throw new Error('Invalid taskId: must be a string');
  }
}

function validateIncomingMessage(data: unknown): asserts data is IncomingMessage {
  validateBaseMessage(data);

  const obj = data as unknown as Record<string, unknown>;
  const action = obj.action as ActionType;

  switch (action) {
    case 'add':
      validateAddTask(obj);
      break;
    case 'stop':
    case 'restart':
      validateTaskIdMessage(obj, true);
      break;
    case 'remove':
      validateTaskIdMessage(obj, false);
      break;
  }
}

// ========================================
// Message Parsing
// ========================================

function parseAddTaskMessage(
  data: AddMockTaskMessage | AddLiveTaskMessage,
  initialBalance?: number
): AddTaskInput {
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
    initialFinance: initialBalance,
    currentBalance: initialBalance,
  };
}

// ========================================
// Action Handlers
// ========================================

async function handleAddTask(data: AddMockTaskMessage | AddLiveTaskMessage): Promise<CopyTask> {
  let initialBalance: number | undefined;

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
    initialBalance = balance;
  }

  const taskInput = parseAddTaskMessage(data, initialBalance);
  const task = await addTask(taskInput);
  logger.info({ taskId: task.id, type: task.type }, 'Task created from Redis subscription');

  return task;
}

async function handleStopTask(data: StopTaskMessage): Promise<{ taskId: string; stopped: boolean }> {
  const { taskId } = data;
  const stopped = await stopTask(taskId);

  if (stopped) {
    logger.info({ taskId }, 'Task stopped from Redis subscription');
  } else {
    logger.warn({ taskId }, 'Task not found for stop action');
  }

  return { taskId, stopped };
}

async function handleRemoveTask(data: RemoveTaskMessage): Promise<{ taskId?: string; count: number }> {
  const { taskId } = data;
  const count = await removeTask(taskId);

  if (taskId) {
    logger.info({ taskId, count }, 'Task removed from Redis subscription');
  } else {
    logger.info({ count }, 'All tasks removed from Redis subscription');
  }

  return { taskId, count };
}

async function handleRestartTask(data: RestartTaskMessage): Promise<{ taskId: string; restarted: boolean }> {
  const { taskId } = data;
  const task = await getTask(taskId);

  if (!task) {
    logger.warn({ taskId }, 'Task not found for restart action');
    return { taskId, restarted: false };
  }

  if (task.status === 'running') {
    logger.warn({ taskId }, 'Task is already running');
    return { taskId, restarted: false };
  }

  // Update task status to running
  task.status = 'running';
  await updateTask(task);

  // Re-schedule the task job
  await scheduleTaskJob(task.id);

  logger.info({ taskId }, 'Task restarted from Redis subscription');
  return { taskId, restarted: true };
}

// ========================================
// Message Processing
// ========================================

async function processMessage(message: string): Promise<void> {
  const data: unknown = JSON.parse(message);
  logger.info('Received message from Redis channel');

  validateIncomingMessage(data);

  const action = data.action;
  let notificationPayload: Record<string, unknown>;

  switch (action) {
    case 'add': {
      const task = await handleAddTask(data as AddMockTaskMessage | AddLiveTaskMessage);
      notificationPayload = {
        event: 'task_created',
        taskId: task.id,
        type: task.type,
        address: task.address,
        status: task.status,
      };
      break;
    }

    case 'stop': {
      const result = await handleStopTask(data as StopTaskMessage);
      notificationPayload = {
        event: 'task_stopped',
        taskId: result.taskId,
        success: result.stopped,
      };
      break;
    }

    case 'remove': {
      const result = await handleRemoveTask(data as RemoveTaskMessage);
      notificationPayload = {
        event: 'task_removed',
        taskId: result.taskId,
        count: result.count,
      };
      break;
    }

    case 'restart': {
      const result = await handleRestartTask(data as RestartTaskMessage);
      notificationPayload = {
        event: 'task_restarted',
        taskId: result.taskId,
        success: result.restarted,
      };
      break;
    }
  }

  await publishNotification(notificationPayload);
}

// ========================================
// Redis Client Management
// ========================================

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

// ========================================
// Public API
// ========================================

export async function startRedisSubscriber(): Promise<void> {
  subscriberClient = createClient({ url: config.redis.url });

  subscriberClient.on('error', (err: Error) => {
    logger.error({ err }, 'Redis subscriber client error');
  });

  await subscriberClient.connect();

  await subscriberClient.subscribe(SUBSCRIBE_CHANNEL, async (message) => {
    try {
      await processMessage(message);
    } catch (err) {
      logger.error({ err, message }, 'Failed to process incoming message from Redis channel');

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
