import { v4 as uuidv4 } from 'uuid';
import { ethers } from 'ethers';
import { getRedisClient } from './redis.js';
import { CopyTask } from '../types/task.js';
import { scheduleTaskJob, removeTaskJob } from './queue.js';
import { UserActivity } from '../models/UserActivity.js';
import { UserPosition } from '../models/UserPosition.js';
import { MockPosition } from '../models/MockPosition.js';
import { mockTradeRecrod } from '../models/mockTradeRecrod.js';
import getMyBalance from '../utils/getMyBalance.js';

const TASKS_KEY = 'copy-polymarket:tasks';
type RawTask = Partial<Omit<CopyTask, 'status'>> & { status?: string; wallet?: string };

function normalizeNumber(value: unknown, fallback: number): number {
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function normalizeTaskStatus(status: string | undefined): CopyTask['status'] {
  return status === 'stopped' ? 'stopped' : 'running';
}

function normalizeTask(task: RawTask): CopyTask {
  const myWalletAddress = task.myWalletAddress || task.wallet || '';
  const base = {
    id: task.id || '',
    address: task.address || '',
    myWalletAddress,
    url: task.url || '',
    initialFinance: normalizeNumber(task.initialFinance, 0),
    currentBalance: normalizeNumber(task.currentBalance, 0),
    fixedAmount: normalizeNumber(task.fixedAmount, 0),
    createdAt: normalizeNumber(task.createdAt, Date.now()),
    status: normalizeTaskStatus(task.status),
  };

  if (task.type === 'mock') {
    return {
      ...base,
      type: 'mock',
      privateKey: task.privateKey,
    };
  }

  return {
    ...base,
    type: 'live',
    privateKey: task.privateKey || '',
  };
}

/**
 * Generates a unique ID using UUID v4, ensuring it doesn't already exist in Redis.
 */
async function generateUniqueId(): Promise<string> {
  const redis = await getRedisClient();
  let id: string;
  do {
    id = uuidv4();
  } while (await redis.hExists(TASKS_KEY, id));

  return id;
}

function generateMockWalletAddress(): string {
  return ethers.Wallet.createRandom().address;
}

async function removeTaskDatabaseRecords(taskIds: string[]): Promise<void> {
  if (taskIds.length === 0) return;
  const uniqueTaskIds = Array.from(new Set(taskIds));

  await Promise.all([
    UserActivity.deleteMany({ taskId: { $in: uniqueTaskIds } }),
    UserPosition.deleteMany({ taskId: { $in: uniqueTaskIds } }),
    MockPosition.deleteMany({ taskId: { $in: uniqueTaskIds } }),
    mockTradeRecrod.deleteMany({ taskId: { $in: uniqueTaskIds } }),
  ]);
}

export type AddMockTaskInput = {
  type: 'mock';
  address: string;
  url: string;
  fixedAmount: number;
  initialFinance: number;
  currentBalance?: number;
  myWalletAddress?: string;
};

export type AddLiveTaskInput = {
  type: 'live';
  address: string;
  url: string;
  fixedAmount: number;
  myWalletAddress: string;
  privateKey: string;
  initialFinance?: number;
  currentBalance?: number;
};

export type AddTaskInput = AddMockTaskInput | AddLiveTaskInput;

export async function addTask(taskData: AddTaskInput): Promise<CopyTask> {
  const redis = await getRedisClient();
  const id = await generateUniqueId();
  let task: CopyTask;

  if (taskData.type === 'mock') {
    const myWalletAddress = taskData.myWalletAddress ?? generateMockWalletAddress();
    const initialFinance = normalizeNumber(taskData.initialFinance, 0);
    const currentBalance = normalizeNumber(taskData.currentBalance, initialFinance);

    task = {
      ...taskData,
      id,
      myWalletAddress,
      initialFinance,
      currentBalance,
      status: 'running',
      createdAt: Date.now(),
    };
  } else {
    const onChainBalance = await getMyBalance(taskData.myWalletAddress);
    const initialFinance = normalizeNumber(taskData.initialFinance, onChainBalance);
    const currentBalance = normalizeNumber(taskData.currentBalance, onChainBalance);

    task = {
      ...taskData,
      id,
      initialFinance,
      currentBalance,
      status: 'running',
      createdAt: Date.now(),
    };
  }

  await redis.hSet(TASKS_KEY, task.id, JSON.stringify(task));
  
  // Schedule the repeating job for this task
  await scheduleTaskJob(task.id);
  
  return task;
}

export async function listTasks(type?: 'live' | 'mock'): Promise<CopyTask[]> {
  const redis = await getRedisClient();
  const allTasksStr = await redis.hGetAll(TASKS_KEY);
  
  const tasks = Object.values(allTasksStr).map((t) => normalizeTask(JSON.parse(t) as RawTask));
  
  if (type) {
    return tasks.filter(t => t.type === type);
  }
  return tasks;
}
  
export async function getTask(id: string): Promise<CopyTask | null> {
  const redis = await getRedisClient();
  const taskStr = await redis.hGet(TASKS_KEY, id);
  if (!taskStr) return null;
  return normalizeTask(JSON.parse(taskStr) as RawTask);
}

export async function stopTask(id: string): Promise<boolean> {
  const redis = await getRedisClient();
  const taskStr = await redis.hGet(TASKS_KEY, id);
  if (!taskStr) return false;

  const task = normalizeTask(JSON.parse(taskStr) as RawTask);
  task.status = 'stopped';
  await redis.hSet(TASKS_KEY, id, JSON.stringify(task));
  
  // Remove the repeating job
  await removeTaskJob(id);
  
  return true;
}

export async function updateTask(task: CopyTask): Promise<void> {
  const redis = await getRedisClient();
  await redis.hSet(TASKS_KEY, task.id, JSON.stringify(task));
}

export async function removeTask(id?: string): Promise<number> {
  const redis = await getRedisClient();
  
  if (id) {
    // Remove specific task job
    await removeTaskJob(id);
    await removeTaskDatabaseRecords([id]);
    return await redis.hDel(TASKS_KEY, id);
  } else {
    // Remove all task jobs
    // We need to list them first to get IDs
    const allTasksStr = await redis.hGetAll(TASKS_KEY);
    const tasks = Object.values(allTasksStr).map(t => JSON.parse(t) as CopyTask);
    
    for (const task of tasks) {
      await removeTaskJob(task.id);
    }
    
    await removeTaskDatabaseRecords(tasks.map((task) => task.id));

    const count = await redis.del(TASKS_KEY);
    return count;
  }
}
