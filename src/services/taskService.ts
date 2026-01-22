import { v4 as uuidv4 } from 'uuid';
import { ethers } from 'ethers';
import { getRedisClient } from './redis.js';
import { CopyTask } from '../types/task.js';
import { scheduleTaskJob, removeTaskJob } from './queue.js';

const TASKS_KEY = 'copy-polymarket:tasks';
type RawTask = Omit<CopyTask, 'status'> & { status: string };

function normalizeTaskStatus(status: string | undefined): CopyTask['status'] {
  return status === 'stopped' ? 'stopped' : 'running';
}

function normalizeTask(task: RawTask): CopyTask {
  return {
    ...task,
    status: normalizeTaskStatus(task.status),
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

export async function addTask(taskData: Omit<CopyTask, 'id' | 'status' | 'createdAt'>): Promise<CopyTask> {
  const redis = await getRedisClient();
  const id = await generateUniqueId();
  const wallet = taskData.wallet ?? (taskData.type === 'mock' ? generateMockWalletAddress() : undefined);
  const task: CopyTask = {
    ...taskData,
    wallet,
    id,
    status: 'running',
    createdAt: Date.now(),
  };

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
    return await redis.hDel(TASKS_KEY, id);
  } else {
    // Remove all task jobs
    // We need to list them first to get IDs
    const allTasksStr = await redis.hGetAll(TASKS_KEY);
    const tasks = Object.values(allTasksStr).map(t => JSON.parse(t) as CopyTask);
    
    for (const task of tasks) {
      await removeTaskJob(task.id);
    }
    
    const count = await redis.del(TASKS_KEY);
    return count;
  }
}
